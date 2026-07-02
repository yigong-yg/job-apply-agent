'use strict';

// Repost cooldown (spec R5): jobId dedup misses repost farms that mint new
// jobIds daily. Normalized company+title matching with a TTL must catch them.
// Uses a temp DB via STATE_DB_PATH — never db/applications.db.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-test-'));
process.env.STATE_DB_PATH = path.join(tmpDir, 'test.db');

const { normalizeCompany, normalizeTitle } = require('../lib/candidate-normalizer');
const state = require('../lib/state');

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

console.log('\n=== Repost Cooldown Tests ===\n');

// ── Normalization (pure) ──

test('normalizeCompany strips corporate suffixes', () => {
  assert.strictEqual(normalizeCompany('BeaconFire Inc.'), normalizeCompany('BeaconFire'));
  assert.strictEqual(normalizeCompany('Emonics LLC'), normalizeCompany('emonics'));
  assert.strictEqual(normalizeCompany('Acme Corp'), normalizeCompany('ACME'));
});

test('normalizeCompany strips punctuation and collapses whitespace', () => {
  assert.strictEqual(normalizeCompany('Pyramid  Consulting,   Inc'), 'pyramid consulting');
});

test('normalizeCompany applies alias table', () => {
  const aliases = { 'tiktok usds joint venture': 'tiktok' };
  assert.strictEqual(normalizeCompany('TikTok USDS Joint Venture', aliases), 'tiktok');
});

test('normalizeTitle strips parenthetical suffixes and bracket tags', () => {
  assert.strictEqual(normalizeTitle('Data Analyst (New York)'), 'data analyst');
  assert.strictEqual(normalizeTitle('Founding Machine Learning Engineer [32913]'), 'founding machine learning engineer');
});

test('normalizeTitle strips punctuation noise', () => {
  assert.strictEqual(normalizeTitle('Sr. Data Scientist I - Rockerbox'), normalizeTitle('Sr Data Scientist I Rockerbox'));
});

test('normalize functions handle empty input', () => {
  assert.strictEqual(normalizeCompany(''), '');
  assert.strictEqual(normalizeTitle(null), '');
});

// ── Cooldown queries against temp DB ──

const { runId } = state.createRun();

state.recordApplication({
  platform: 'linkedin', jobId: 'job-1', jobTitle: 'Data Analyst',
  company: 'ATC', jobUrl: 'https://x/1', status: 'submitted', runId,
});
state.recordApplication({
  platform: 'linkedin', jobId: 'job-2', jobTitle: 'Data Analyst',
  company: 'ATC', jobUrl: 'https://x/2', status: 'submitted', runId,
});
state.recordApplication({
  platform: 'linkedin', jobId: 'job-3', jobTitle: 'ML Engineer',
  company: 'Nice Co', jobUrl: 'https://x/3', status: 'skipped', skipReason: 'test', runId,
});

test('detects repost: same normalized company+title, new jobId, within TTL', () => {
  const hit = state.hasRecentCompanyTitleApplication({
    platform: 'linkedin', company: 'ATC Inc.', jobTitle: 'Data Analyst (Remote)', days: 30,
  });
  assert.strictEqual(hit, true);
});

test('no repost hit for a different title at same company', () => {
  const hit = state.hasRecentCompanyTitleApplication({
    platform: 'linkedin', company: 'ATC', jobTitle: 'Machine Learning Engineer', days: 30,
  });
  assert.strictEqual(hit, false);
});

test('skipped rows do not count as prior applications', () => {
  const hit = state.hasRecentCompanyTitleApplication({
    platform: 'linkedin', company: 'Nice Co', jobTitle: 'ML Engineer', days: 30,
  });
  assert.strictEqual(hit, false);
});

test('counts recent submissions per company across titles', () => {
  const n = state.getCompanyRecentSubmissionCount({ platform: 'linkedin', company: 'atc', days: 30 });
  assert.strictEqual(n, 2);
});

test('old submissions fall outside the TTL window', () => {
  // Age job-1 and job-2 to 40 days ago via a direct connection to the temp DB
  const Database = require('better-sqlite3');
  const raw = new Database(process.env.STATE_DB_PATH);
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  raw.prepare(`update applications set appliedAt = ? where company = 'ATC'`).run(old);
  raw.close();

  const hit = state.hasRecentCompanyTitleApplication({
    platform: 'linkedin', company: 'ATC', jobTitle: 'Data Analyst', days: 30,
  });
  assert.strictEqual(hit, false);

  const n = state.getCompanyRecentSubmissionCount({ platform: 'linkedin', company: 'ATC', days: 30 });
  assert.strictEqual(n, 0);
});

test('missing company never matches the cooldown', () => {
  const hit = state.hasRecentCompanyTitleApplication({
    platform: 'linkedin', company: null, jobTitle: 'Data Analyst', days: 30,
  });
  assert.strictEqual(hit, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
