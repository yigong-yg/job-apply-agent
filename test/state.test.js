'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-state-test-'));
process.env.STATE_DB_PATH = path.join(tmpDir, 'test.db');

// Seed a pre-mode schema before loading lib/state. Its dry_run outcome is
// authoritative migration evidence; the accompanying error must not poison
// production cooldowns after initSchema upgrades the database.
const legacyRunId = 'legacy-dry-run';
const legacyDb = new Database(process.env.STATE_DB_PATH);
legacyDb.exec(`
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    jobId TEXT NOT NULL,
    jobTitle TEXT,
    company TEXT,
    jobUrl TEXT,
    status TEXT NOT NULL,
    errorMessage TEXT,
    appliedAt TEXT NOT NULL,
    runId TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    startedAt TEXT NOT NULL,
    completedAt TEXT,
    platformStats TEXT
  );
  INSERT INTO runs (id, startedAt) VALUES ('legacy-dry-run', datetime('now'));
  INSERT INTO applications
    (platform, jobId, jobTitle, company, status, appliedAt, runId)
  VALUES
    ('linkedin', 'legacy-ready', 'Legacy Dry Analyst', 'Legacy Dry Co', 'dry_run', datetime('now'), 'legacy-dry-run');
  INSERT INTO applications
    (platform, jobId, jobTitle, company, status, errorMessage, appliedAt, runId)
  VALUES
    ('linkedin', 'legacy-error', 'Legacy Dry Analyst', 'Legacy Dry Co', 'error', 'diagnostic failure', datetime('now'), 'legacy-dry-run');
`);
legacyDb.close();

const state = require('../lib/state');
const { denverDayStartUTC } = state;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

console.log('\n=== State Module Tests ===\n');

test('converts Denver midnight to UTC during daylight time', () => {
  assert.strictEqual(denverDayStartUTC('2026-04-09'), '2026-04-09T06:00:00.000Z');
});

test('converts Denver midnight to UTC during standard time', () => {
  assert.strictEqual(denverDayStartUTC('2026-12-09'), '2026-12-09T07:00:00.000Z');
});

test('uses the pre-transition offset on DST start day', () => {
  assert.strictEqual(denverDayStartUTC('2026-03-08'), '2026-03-08T07:00:00.000Z');
});

test('uses the pre-fall-back offset on DST end day', () => {
  assert.strictEqual(denverDayStartUTC('2026-11-01'), '2026-11-01T06:00:00.000Z');
});

const { runId } = state.createRun();

test('migration backfills legacy dry-run mode before cooldown queries', () => {
  assert.strictEqual(
    state.hasRecentFailure({
      platform: 'linkedin', jobId: 'legacy-error',
      company: 'Legacy Dry Co', jobTitle: 'Legacy Dry Analyst',
    }),
    false
  );
  assert.strictEqual(
    state.getCompanyRecentAttemptCount({ platform: 'linkedin', company: 'Legacy Dry Co' }),
    0
  );
});

test('submitted rows are proof of a prior application', () => {
  state.recordApplication({
    platform: 'linkedin', jobId: 'submitted-job', status: 'submitted', runId,
  });

  assert.strictEqual(state.hasApplied('linkedin', 'submitted-job'), true);
});

test('LinkedIn already-applied evidence is proof of a prior application', () => {
  state.recordApplication({
    platform: 'linkedin', jobId: 'linkedin-applied-job', status: 'already_applied',
    skipReason: 'already_applied_linkedin', runId,
  });

  assert.strictEqual(state.hasApplied('linkedin', 'linkedin-applied-job'), true);
});

test('dry-run rows are not proof of a prior application', () => {
  state.recordApplication({
    platform: 'linkedin', jobId: 'dry-run-job', status: 'dry_run', runId,
  });

  assert.strictEqual(state.hasApplied('linkedin', 'dry-run-job'), false);
});

test('database-dedup rows cannot become self-sustaining proof', () => {
  state.recordApplication({
    platform: 'linkedin', jobId: 'db-dedup-job', status: 'already_applied',
    skipReason: 'already_applied_db', runId,
  });

  assert.strictEqual(state.hasApplied('linkedin', 'db-dedup-job'), false);
});

test('unattributed already-applied rows are not authoritative proof', () => {
  assert.throws(() => state.recordApplication({
    platform: 'linkedin', jobId: 'unattributed-applied-job', status: 'already_applied', runId,
  }), /requires skipReason/);
  assert.strictEqual(state.hasApplied('linkedin', 'unattributed-applied-job'), false);
});

test('other platforms keep their authoritative already-applied evidence', () => {
  state.recordApplication({
    platform: 'indeed', jobId: 'indeed-applied-job', status: 'already_applied',
    skipReason: 'already_applied_indeed', runId,
  });

  assert.strictEqual(state.hasApplied('indeed', 'indeed-applied-job'), true);
});

test('dry-run failures do not feed the production failure cooldown', () => {
  const { runId: dryRunId } = state.createRun({ mode: 'dry_run' });
  state.recordApplication({
    platform: 'linkedin', jobId: 'dry-fail-job', jobTitle: 'Dry Fail Analyst',
    company: 'Dry Fail Co', status: 'error', errorMessage: 'boom', runId: dryRunId,
  });

  assert.strictEqual(
    state.hasRecentFailure({ platform: 'linkedin', jobId: 'dry-fail-job', company: 'Dry Fail Co', jobTitle: 'Dry Fail Analyst' }),
    false
  );
  assert.strictEqual(
    state.getCompanyRecentAttemptCount({ platform: 'linkedin', company: 'Dry Fail Co' }),
    0
  );
});

test('production failures still feed the failure cooldown', () => {
  state.recordApplication({
    platform: 'linkedin', jobId: 'prod-fail-job', jobTitle: 'Prod Fail Analyst',
    company: 'Prod Fail Co', status: 'error', errorMessage: 'boom', runId,
  });

  assert.strictEqual(
    state.hasRecentFailure({ platform: 'linkedin', jobId: 'prod-fail-job', company: 'Prod Fail Co', jobTitle: 'Prod Fail Analyst' }),
    true
  );
  assert.strictEqual(
    state.getCompanyRecentAttemptCount({ platform: 'linkedin', company: 'Prod Fail Co' }),
    1
  );
});

test('run stats surface captcha-blocked rows', () => {
  const { runId: captchaRunId } = state.createRun();
  state.recordApplication({
    platform: 'indeed', jobId: 'captcha-job', status: 'captcha_blocked',
    errorMessage: 'challenge page', runId: captchaRunId,
  });

  assert.strictEqual(state.getRunStats(captchaRunId).indeed.captcha_blocked, 1);
});

test('unconfirmed submit is an error, terminal failure, and daily budget use', () => {
  const beforeBudget = state.getTodaySubmissionBudgetCount();
  const beforeSubmitted = state.getTodaySubmittedCount();
  const { runId: unconfirmedRunId } = state.createRun();
  state.recordApplication({
    platform: 'linkedin', jobId: 'unconfirmed-job', jobTitle: 'Unconfirmed Analyst',
    company: 'Unconfirmed Co', status: 'submit_unconfirmed',
    errorMessage: 'Submit clicked but evidence timed out', runId: unconfirmedRunId,
  });

  const stats = state.getRunStats(unconfirmedRunId).linkedin;
  assert.strictEqual(stats.submit_unconfirmed, 1);
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(state.getTodaySubmissionBudgetCount(), beforeBudget + 1);
  assert.strictEqual(state.getTodaySubmittedCount(), beforeSubmitted);
  assert.strictEqual(
    state.hasRecentFailure({
      platform: 'linkedin', jobId: 'unconfirmed-job',
      company: 'Unconfirmed Co', jobTitle: 'Unconfirmed Analyst',
    }),
    true
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
