'use strict';

const assert = require('assert');
const {
  buildLinkedInSearchUrl,
  summarizeResultCard,
  shouldApply,
  hasLinkedInDailySubmissionLimitMessage,
  normalizeVisibleText,
} = require('../modules/linkedin');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}: ${e.message}`); }
}

console.log('\n=== LinkedIn Module Tests ===\n');

// ── buildLinkedInSearchUrl ──

test('builds /jobs/search-results/ URL with keywords', () => {
  const url = buildLinkedInSearchUrl({
    search: { keywords: ['data scientist', 'ML engineer'] },
    platforms: { linkedin: { geoId: '102095887', distance: 0 } },
  });
  assert(url.startsWith('https://www.linkedin.com/jobs/search-results/'));
  assert(url.includes('keywords=data+scientist+ML+engineer'));
  assert(url.includes('geoId=102095887'));
  assert(url.includes('f_AL=true'));
  assert(url.includes('f_TPR=r86400'));
});

test('includes f_SAL when provided', () => {
  const url = buildLinkedInSearchUrl({
    search: { keywords: ['analyst'] },
    platforms: { linkedin: { f_SAL: 'f_SA_id_227001:276001' } },
  });
  assert(url.includes('f_SAL='));
});

test('omits f_SAL when empty', () => {
  const url = buildLinkedInSearchUrl({
    search: { keywords: ['analyst'] },
    platforms: { linkedin: {} },
  });
  assert(!url.includes('f_SAL'));
});

test('defaults keywords when none provided', () => {
  const url = buildLinkedInSearchUrl({ search: {}, platforms: {} });
  assert(url.includes('keywords=data+scientist'));
});

// ── summarizeResultCard ──

test('parses verified card text (title repeated on line 2)', () => {
  const text = `Data Scientist (Verified job)
Data Scientist
Stripe
San Francisco, CA (Hybrid)
$155K/yr - $185K/yr
Be an early applicant · Posted on April 9, 2026 · Easy Apply`;
  const s = summarizeResultCard(text);
  assert.strictEqual(s.title, 'Data Scientist');
  assert.strictEqual(s.company, 'Stripe');
  assert.strictEqual(s.location, 'San Francisco, CA (Hybrid)');
  assert(s.hasEasyApplyBadge);
  assert(!s.hasAppliedBadge);
});

test('parses non-verified card text', () => {
  const text = `Data Analyst
Infobahn Softworld Inc
San Jose, CA (On-site)
Viewed · Be an early applicant · Easy Apply`;
  const s = summarizeResultCard(text);
  assert.strictEqual(s.title, 'Data Analyst');
  assert.strictEqual(s.company, 'Infobahn Softworld Inc');
  assert.strictEqual(s.location, 'San Jose, CA (On-site)');
});

test('detects Applied badge', () => {
  const text = `ML Engineer
Google
Remote
Applied · Be an early applicant · Easy Apply`;
  const s = summarizeResultCard(text);
  assert(s.hasAppliedBadge);
});

test('returns null for too-short text', () => {
  assert.strictEqual(summarizeResultCard(''), null);
  assert.strictEqual(summarizeResultCard('short'), null);
  assert.strictEqual(summarizeResultCard(null), null);
});

test('strips "(Verified job)" from title', () => {
  const text = `Senior Data Engineer (Verified job)
Senior Data Engineer
Meta
Menlo Park, CA (On-site)
Easy Apply`;
  const s = summarizeResultCard(text);
  assert.strictEqual(s.title, 'Senior Data Engineer');
  assert.strictEqual(s.company, 'Meta');
});

test('parses card with Dismiss button in text', () => {
  const text = `AI Engineer (Verified job)
AI Engineer
Kickmaker
San Francisco, CA (Hybrid)
Dismiss AI Engineer job
$155K/yr - $180K/yr
Be an early applicant · Easy Apply`;
  const s = summarizeResultCard(text);
  assert.strictEqual(s.title, 'AI Engineer');
  assert.strictEqual(s.company, 'Kickmaker');
});

// ── shouldApply ──

test('passes when no filter configured', () => {
  const r = shouldApply('Data Scientist', 'Stripe', { search: {} });
  assert(r.apply);
});

test('blocks by company name (substring match)', () => {
  const config = { search: { jobFilter: { blockCompanies: ['Net2Source'] } } };
  const r = shouldApply('Data Scientist', 'Net2Source Inc.', config);
  assert(!r.apply);
  assert(r.skipReason.includes('blocked_company'));
});

test('blocks by title keyword (word boundary)', () => {
  const config = { search: { jobFilter: { blockTitleKeywords: ['intern'] } } };
  const r = shouldApply('Data Analyst Intern', 'Acme', config);
  assert(!r.apply);
});

test('does not block "internal" by "intern" keyword', () => {
  const config = { search: { jobFilter: { blockTitleKeywords: ['intern'] } } };
  const r = shouldApply('Internal Data Analyst', 'Acme', config);
  assert(r.apply);
});

test('requires title keyword match (phrase)', () => {
  const config = { search: { jobFilter: { requireTitleKeywords: ['data scientist', 'ML engineer'] } } };
  assert(shouldApply('Senior Data Scientist', 'Co', config).apply);
  assert(!shouldApply('Hadoop Developer', 'Co', config).apply);
});

test('requires title keyword match (single word boundary)', () => {
  const config = { search: { jobFilter: { requireTitleKeywords: ['NLP'] } } };
  assert(shouldApply('NLP Engineer', 'Co', config).apply);
  assert(!shouldApply('HTML Developer', 'Co', config).apply);
});

// ── hasLinkedInDailySubmissionLimitMessage ──

test('detects exact daily limit message', () => {
  const msg = 'We limit daily submissions to maintain quality and prevent bots, helping each application get the right attention. Save this job and apply tomorrow.';
  assert(hasLinkedInDailySubmissionLimitMessage(msg));
});

test('detects message with extra whitespace', () => {
  const msg = '  We  limit  daily  submissions  to  maintain  quality  and  prevent  bots,  helping  each  application  get  the  right  attention.  Save  this  job  and  apply  tomorrow.  ';
  assert(hasLinkedInDailySubmissionLimitMessage(msg));
});

test('does not match partial text', () => {
  assert(!hasLinkedInDailySubmissionLimitMessage('We limit daily submissions'));
});

test('does not match empty text', () => {
  assert(!hasLinkedInDailySubmissionLimitMessage(''));
  assert(!hasLinkedInDailySubmissionLimitMessage(null));
});

// ── normalizeVisibleText ──

test('normalizes whitespace', () => {
  assert.strictEqual(normalizeVisibleText('  hello   world  '), 'hello world');
});

test('handles null/undefined', () => {
  assert.strictEqual(normalizeVisibleText(null), '');
  assert.strictEqual(normalizeVisibleText(undefined), '');
});

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
