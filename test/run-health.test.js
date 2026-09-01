'use strict';

const assert = require('assert');
const { getRunExitCode, clampToDailyBudget } = require('../lib/run-health');

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

console.log('\n=== Run Health Tests ===\n');

test('fails a production run with errors and zero submissions', () => {
  assert.strictEqual(getRunExitCode({ totalApplied: 0, totalErrors: 1 }), 1);
});

test('does not fail a production run that submitted at least one job', () => {
  assert.strictEqual(getRunExitCode({ totalApplied: 1, totalErrors: 4 }), 0);
});

test('allows a production run with no work and no errors', () => {
  assert.strictEqual(getRunExitCode({ totalApplied: 0, totalErrors: 0 }), 0);
});

test('does not apply the zero-submission error policy to dry runs', () => {
  assert.strictEqual(getRunExitCode({ dryRun: true, totalApplied: 0, totalErrors: 3 }), 0);
});

test('still fails a dry run when a platform crashes', () => {
  assert.strictEqual(getRunExitCode({ dryRun: true, platformCrashed: true }), 1);
});

test('preserves the session-expired exit code', () => {
  assert.strictEqual(getRunExitCode({ sessionExpired: true }), 3);
});

test('session expiry takes precedence over a platform crash', () => {
  assert.strictEqual(getRunExitCode({ sessionExpired: true, platformCrashed: true }), 3);
});

test('fails a captcha-blocked production run with zero submissions', () => {
  assert.strictEqual(getRunExitCode({ totalApplied: 0, totalErrors: 0, captchaBlocked: true }), 1);
});

test('a captcha stop after real submissions is still a completed run', () => {
  assert.strictEqual(getRunExitCode({ totalApplied: 3, captchaBlocked: true }), 0);
});

test('daily budget subtracts prior submissions from the ceiling', () => {
  assert.strictEqual(clampToDailyBudget({ perRunMax: 100, dailyCap: 30, submittedToday: 14 }), 16);
});

test('daily budget reaches zero at the ceiling', () => {
  assert.strictEqual(clampToDailyBudget({ perRunMax: 100, dailyCap: 30, submittedToday: 30 }), 0);
  assert.strictEqual(clampToDailyBudget({ perRunMax: 100, dailyCap: 30, submittedToday: 45 }), 0);
});

test('a smaller per-run max still binds under the daily budget', () => {
  assert.strictEqual(clampToDailyBudget({ perRunMax: 5, dailyCap: 30, submittedToday: 14 }), 5);
});

test('an unset per-run max falls back to the remaining daily allowance', () => {
  assert.strictEqual(clampToDailyBudget({ perRunMax: 0, dailyCap: 30, submittedToday: 12 }), 18);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
