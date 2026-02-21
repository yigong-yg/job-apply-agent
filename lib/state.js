'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Ensure db directory exists
const dbDir = path.join(process.cwd(), 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'applications.db');

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
  `);
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
 * Record an application attempt in the database.
 */
function recordApplication({ platform, jobId, jobTitle, company, jobUrl, status, errorMessage, runId }) {
  const d = getDb();
  const now = new Date().toISOString();

  // Append-only INSERT: every attempt is preserved as its own row.
  // This keeps the full audit trail across retries and re-runs.
  // Use the `latest_applications` view to query the most recent status per job.
  d.prepare(`
    INSERT INTO applications
      (platform, jobId, jobTitle, company, jobUrl, status, errorMessage, appliedAt, runId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(platform, jobId, jobTitle || null, company || null, jobUrl || null, status, errorMessage || null, now, runId);
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
 * Create a new run record and return its ID.
 * @returns {string} runId (UUID)
 */
function createRun() {
  const d = getDb();
  const runId = uuidv4();
  const now = new Date().toISOString();
  d.prepare(`
    INSERT INTO runs (id, startedAt) VALUES (?, ?)
  `).run(runId, now);
  return runId;
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

module.exports = {
  hasApplied,
  recordApplication,
  recordUnfilledField,
  createRun,
  completeRun,
  getRunStats,
};
