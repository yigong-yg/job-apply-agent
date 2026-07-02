'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { normalizeCompany, normalizeTitle } = require('./candidate-normalizer');

// STATE_DB_PATH overrides the default location — used by tests so they never
// touch the production db/applications.db.
const dbPath = process.env.STATE_DB_PATH || (() => {
  const dbDir = path.join(process.cwd(), 'db');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'applications.db');
})();

let db;

function getDb() {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // Better concurrent performance
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDb();

  // Drop the old unique index if it exists (migration from v1 schema).
  // The new index (idx_applications_platform_jobId_v2) is non-unique to allow
  // append-only audit rows for the same job across retries and re-runs.
  d.exec(`DROP INDEX IF EXISTS idx_applications_platform_jobId;`);

  d.exec(`
    -- Append-only attempts table: every attempt is a new row for full audit history.
    -- hasApplied() queries this table to detect prior successes; it never overwrites rows.
    CREATE TABLE IF NOT EXISTS applications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      platform      TEXT NOT NULL,
      jobId         TEXT NOT NULL,
      jobTitle      TEXT,
      company       TEXT,
      jobUrl        TEXT,
      status        TEXT NOT NULL,
      errorMessage  TEXT,
      skipReason    TEXT,
      appliedAt     TEXT NOT NULL,
      runId         TEXT NOT NULL
    );

    -- Non-unique index for fast per-job lookup (allows multiple attempt rows per job)
    CREATE INDEX IF NOT EXISTS idx_applications_platform_jobId_v2
      ON applications (platform, jobId);

    -- Convenience view: the most recent attempt row for each (platform, jobId) pair.
    -- Use this for dashboards; use the base table for full audit queries.
    CREATE VIEW IF NOT EXISTS latest_applications AS
      SELECT * FROM applications
      WHERE id IN (
        SELECT MAX(id) FROM applications GROUP BY platform, jobId
      );

    CREATE TABLE IF NOT EXISTS runs (
      id            TEXT PRIMARY KEY,
      sessionId     INTEGER,
      startedAt     TEXT NOT NULL,
      completedAt   TEXT,
      platformStats TEXT
    );

    CREATE TABLE IF NOT EXISTS unfilled_fields (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      platform      TEXT NOT NULL,
      jobId         TEXT,
      fieldLabel    TEXT NOT NULL,
      fieldType     TEXT,
      timestamp     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fill_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      platform    TEXT NOT NULL,
      jobId       TEXT,
      runId       TEXT NOT NULL,
      fieldLabel  TEXT NOT NULL,
      fieldType   TEXT,
      inputType   TEXT,
      fillSource  TEXT NOT NULL,
      answer      TEXT,
      confidence  TEXT,
      timestamp   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fill_audit_source ON fill_audit (fillSource, timestamp);
    CREATE INDEX IF NOT EXISTS idx_fill_audit_run ON fill_audit (runId);
  `);

  // Migrations for existing databases
  const appCols = d.pragma('table_info(applications)').map(c => c.name);
  if (!appCols.includes('skipReason')) {
    d.exec('ALTER TABLE applications ADD COLUMN skipReason TEXT');
  }
  if (!appCols.includes('source')) {
    d.exec('ALTER TABLE applications ADD COLUMN source TEXT');
  }
  const runCols = d.pragma('table_info(runs)').map(c => c.name);
  if (!runCols.includes('sessionId')) {
    d.exec('ALTER TABLE runs ADD COLUMN sessionId INTEGER');
  }
}

/**
 * Check if an application has already been submitted for this job.
 * @param {string} platform
 * @param {string} jobId
 * @returns {boolean}
 */
function hasApplied(platform, jobId) {
  const d = getDb();
  const row = d.prepare(
    "SELECT id FROM applications WHERE platform = ? AND jobId = ? AND status IN ('submitted', 'already_applied', 'dry_run')"
  ).get(platform, jobId);
  return !!row;
}

/**
 * Repost cooldown (spec R5): has a job with the same normalized
 * company+title been SUBMITTED within the last `days`? Catches repost
 * farms that mint a new jobId for the same listing every day.
 *
 * @returns {boolean}
 */
function hasRecentCompanyTitleApplication({ platform, company, jobTitle, days = 30 }) {
  const normCompany = normalizeCompany(company);
  const normTitle = normalizeTitle(jobTitle);
  if (!normCompany || !normTitle) return false;

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = getDb().prepare(`
    SELECT company, jobTitle FROM applications
    WHERE platform = ? AND status = 'submitted' AND appliedAt >= ? AND company IS NOT NULL
  `).all(platform, cutoff);

  return rows.some((r) =>
    normalizeCompany(r.company) === normCompany && normalizeTitle(r.jobTitle) === normTitle);
}

/**
 * How many submissions went to this normalized company in the last `days`?
 * Backs the per-company caps from spec R5.
 *
 * @returns {number}
 */
function getCompanyRecentSubmissionCount({ platform, company, days = 30 }) {
  const normCompany = normalizeCompany(company);
  if (!normCompany) return 0;

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = getDb().prepare(`
    SELECT company FROM applications
    WHERE platform = ? AND status = 'submitted' AND appliedAt >= ? AND company IS NOT NULL
  `).all(platform, cutoff);

  return rows.filter((r) => normalizeCompany(r.company) === normCompany).length;
}

/**
 * Record an application attempt in the database.
 */
function recordApplication({ platform, jobId, jobTitle, company, jobUrl, status, errorMessage, skipReason, runId, source }) {
  const d = getDb();
  const now = new Date().toISOString();

  // Append-only INSERT: every attempt is preserved as its own row.
  // This keeps the full audit trail across retries and re-runs.
  // Use the `latest_applications` view to query the most recent status per job.
  d.prepare(`
    INSERT INTO applications
      (platform, jobId, jobTitle, company, jobUrl, status, errorMessage, skipReason, appliedAt, runId, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(platform, jobId, jobTitle || null, company || null, jobUrl || null, status, errorMessage || null, skipReason || null, now, runId, source || null);
}

/**
 * Log a form field that couldn't be matched to a default answer.
 */
function recordUnfilledField({ platform, jobId, fieldLabel, fieldType }) {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(`
    INSERT INTO unfilled_fields (platform, jobId, fieldLabel, fieldType, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(platform, jobId || null, fieldLabel, fieldType || null, now);
}

/**
 * Create a new run record with auto-increment session ID.
 * @returns {{ runId: string, sessionId: number }}
 */
function createRun() {
  const d = getDb();
  const runId = uuidv4();
  const now = new Date().toISOString();
  const maxRow = d.prepare('SELECT MAX(sessionId) as maxId FROM runs').get();
  const sessionId = (maxRow.maxId || 0) + 1;
  d.prepare(`
    INSERT INTO runs (id, sessionId, startedAt) VALUES (?, ?, ?)
  `).run(runId, sessionId, now);
  return { runId, sessionId };
}

/**
 * Mark a run as complete with platform statistics.
 * @param {string} runId
 * @param {object} stats - e.g. { linkedin: { applied: 15, skipped: 3, errors: 2 } }
 */
function completeRun(runId, stats) {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(`
    UPDATE runs SET completedAt = ?, platformStats = ? WHERE id = ?
  `).run(now, JSON.stringify(stats), runId);
}

/**
 * Count unfilled form fields recorded during a run.
 * Uses the run's startedAt timestamp as a range boundary since
 * unfilled_fields has no runId column.
 * @param {string} runId
 * @returns {number}
 */
function getUnfilledFieldsCount(runId) {
  const d = getDb();
  const row = d.prepare(
    'SELECT COUNT(*) as count FROM unfilled_fields WHERE timestamp >= (SELECT startedAt FROM runs WHERE id = ?)'
  ).get(runId);
  return row ? row.count : 0;
}

/**
 * Record a form field fill event for audit/analytics.
 * @param {{ platform: string, jobId?: string, runId: string, fieldLabel: string, fieldType?: string, inputType?: string, fillSource: string, answer?: string, confidence?: string }} entry
 */
function recordFillAudit({ platform, jobId, runId, fieldLabel, fieldType, inputType, fillSource, answer, confidence }) {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(`
    INSERT INTO fill_audit (platform, jobId, runId, fieldLabel, fieldType, inputType, fillSource, answer, confidence, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(platform, jobId || null, runId, fieldLabel, fieldType || null, inputType || null, fillSource, answer || null, confidence || null, now);
}

/**
 * Get fill source distribution for a given run.
 * @param {string} runId
 * @returns {object} e.g. { defaultAnswers: 45, 'rule:city_location': 3, llm: 2, safe_default: 1, cannot_fill: 0 }
 */
function getFillSourceStats(runId) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT fillSource, COUNT(*) as count
    FROM fill_audit
    WHERE runId = ?
    GROUP BY fillSource
  `).all(runId);

  const stats = {};
  for (const row of rows) {
    stats[row.fillSource] = row.count;
  }
  return stats;
}

/**
 * Get per-status counts for a run.
 * @param {string} runId
 * @returns {object}
 */
function getRunStats(runId) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT platform, status, COUNT(*) as count
    FROM applications
    WHERE runId = ?
    GROUP BY platform, status
  `).all(runId);

  const stats = {};
  for (const row of rows) {
    if (!stats[row.platform]) {
      stats[row.platform] = { applied: 0, skipped: 0, errors: 0, dry_run: 0, already_applied: 0 };
    }
    if (row.status === 'submitted') stats[row.platform].applied += row.count;
    else if (row.status === 'skipped') stats[row.platform].skipped += row.count;
    else if (row.status === 'error') stats[row.platform].errors += row.count;
    else if (row.status === 'dry_run') stats[row.platform].dry_run += row.count;
    else if (row.status === 'already_applied') stats[row.platform].already_applied += row.count;
  }
  return stats;
}

/**
 * Return count of submitted applications today in America/Denver timezone.
 */
function getTodaySubmittedCount() {
  const d = getDb();
  // Compute today's date boundary in America/Denver, then query in UTC
  const denverToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const row = d.prepare(
    "SELECT COUNT(*) as count FROM applications WHERE status = 'submitted' AND appliedAt >= ? AND appliedAt < ?"
  ).get(denverDayStartUTC(denverToday), denverDayStartUTC(nextDay(denverToday)));
  return row.count;
}

/**
 * Count submitted applications this week (Mon-Sun) in America/Denver timezone.
 */
function getWeekSubmittedCount() {
  const d = getDb();
  const denverToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const monday = denverWeekStartDate(denverToday);
  const nextMonday = nextDay(monday, 7);
  const row = d.prepare(
    "SELECT COUNT(*) as count FROM applications WHERE status = 'submitted' AND appliedAt >= ? AND appliedAt < ?"
  ).get(denverDayStartUTC(monday), denverDayStartUTC(nextMonday));
  return row.count;
}

/**
 * Convert a Denver local date (YYYY-MM-DD) to the UTC ISO timestamp
 * at the start of that day in America/Denver.
 */
function denverDayStartUTC(dateStr) {
  const utcMidnightMs = Date.parse(`${dateStr}T00:00:00.000Z`);
  const offsetMinutes = getDenverUtcOffsetMinutes(dateStr);
  return new Date(utcMidnightMs - offsetMinutes * 60 * 1000).toISOString();
}

/**
 * Return America/Denver's UTC offset in minutes for the given local date.
 * Probe 07:00Z because it lands between Denver midnight and 1 AM, before
 * either DST transition time at 2 AM local.
 */
function getDenverUtcOffsetMinutes(dateStr) {
  const probe = new Date(`${dateStr}T07:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    timeZoneName: 'shortOffset',
  }).formatToParts(probe);

  const tzName = parts.find(part => part.type === 'timeZoneName')?.value || '';
  const match = tzName.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Could not parse America/Denver offset: ${tzName || 'missing timeZoneName'}`);
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3] || '0', 10);
  return sign * (hours * 60 + minutes);
}

function nextDay(dateStr, days = 1) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function denverWeekStartDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Total application records in DB.
 */
function getDbTotal() {
  const d = getDb();
  return d.prepare('SELECT COUNT(*) as count FROM applications').get().count;
}

/**
 * Get skip/error reason distribution for a run.
 * @returns {Array<{reason: string, count: number}>} sorted by count desc
 */
function getFailReasons(runId) {
  const d = getDb();
  return d.prepare(`
    SELECT COALESCE(skipReason, errorMessage, 'unknown') as reason, COUNT(*) as count
    FROM applications
    WHERE runId = ? AND status IN ('error', 'skipped') AND (skipReason IS NULL OR skipReason NOT IN ('already_applied_db', 'already_applied_linkedin', 'no_easy_apply_button', 'promoted'))
    GROUP BY reason ORDER BY count DESC LIMIT 5
  `).all(runId);
}

/**
 * Count LLM (DeepSeek) fill calls for a run.
 */
function getLlmCallCount(runId) {
  const d = getDb();
  const row = d.prepare(
    "SELECT COUNT(*) as count FROM fill_audit WHERE runId = ? AND fillSource LIKE 'llm%'"
  ).get(runId);
  return row.count;
}

module.exports = {
  hasApplied,
  hasRecentCompanyTitleApplication,
  getCompanyRecentSubmissionCount,
  recordApplication,
  recordUnfilledField,
  recordFillAudit,
  getFillSourceStats,
  createRun,
  completeRun,
  getRunStats,
  getUnfilledFieldsCount,
  getTodaySubmittedCount,
  getWeekSubmittedCount,
  denverDayStartUTC,
  getDbTotal,
  getFailReasons,
  getLlmCallCount,
};
