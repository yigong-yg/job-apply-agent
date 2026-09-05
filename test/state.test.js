'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-state-test-'));
process.env.STATE_DB_PATH = path.join(tmpDir, 'test.db');

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
  state.recordApplication({
    platform: 'linkedin', jobId: 'unattributed-applied-job', status: 'already_applied', runId,
  });

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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
