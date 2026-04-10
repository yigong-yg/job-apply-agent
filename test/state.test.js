'use strict';

const assert = require('assert');
const { denverDayStartUTC } = require('../lib/state');

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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
