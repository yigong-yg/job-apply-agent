'use strict';

const assert = require('assert');
const {
  buildLinkedInSearchUrl,
  summarizeResultCard,
  shouldApply,
  hasLinkedInDailySubmissionLimitMessage,
  normalizeVisibleText,
  analyzeSearchPageState,
  pickCardStrategy,
  isJobCardText,
  APPLY_LINK_ARIA_LABELS,
  buildApplyLinkSelector,
  mapEducationAnswerToYesNo,
  matchDialogRadioOption,
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

test('uses configured LinkedIn date window when provided', () => {
  const url = buildLinkedInSearchUrl({
    search: { keywords: ['data scientist'] },
    platforms: { linkedin: { f_TPR: 'r604800' } },
  });
  assert(url.includes('f_TPR=r604800'));
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

test('blocks likely recruiting agencies by default when jobFilter is configured', () => {
  const config = { search: { jobFilter: {} } };
  assert(!shouldApply('Data Scientist', 'BeaconFire', config).apply);
  assert(!shouldApply('Data Scientist', 'Proven Recruiting', config).apply);
  assert(!shouldApply('ML Engineer', 'HirePower Staffing Solution', config).apply);
  assert(!shouldApply('AI Engineer', 'Jobright.ai', config).apply);
});

test('does not block direct employers with agency filter enabled', () => {
  const config = { search: { jobFilter: {} } };
  assert(shouldApply('Data Scientist', 'TikTok USDS Joint Venture', config).apply);
  assert(shouldApply('Machine Learning Engineer', 'Roku', config).apply);
  assert(shouldApply('AI Engineer', 'Enigma', config).apply);
  assert(shouldApply('Data Engineer', 'Mainspring Energy', config).apply);
});

test('can disable default recruiting agency block', () => {
  const config = { search: { jobFilter: { blockLikelyRecruitingAgencies: false } } };
  assert(shouldApply('Data Scientist', 'BeaconFire', config).apply);
});

test('blocks configured company keyword and pattern signals', () => {
  const config = {
    search: {
      jobFilter: {
        blockLikelyRecruitingAgencies: false,
        blockCompanyKeywords: ['sourcing firm'],
        blockCompanyPatterns: ['^Example Talent$'],
      },
    },
  };
  assert(!shouldApply('Data Scientist', 'Bright Sourcing Firm LLC', config).apply);
  assert(!shouldApply('Data Scientist', 'Example Talent', config).apply);
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

test('allows configured state aliases in location filter', () => {
  const config = { search: { locationFilter: ['California', 'New York', 'Massachusetts'], jobFilter: {} } };
  assert(shouldApply('Data Scientist', 'Co', 'San Francisco, CA (Hybrid)', config).apply);
  assert(shouldApply('Data Scientist', 'Co', 'New York, NY (On-site)', config).apply);
  assert(shouldApply('Data Scientist', 'Co', 'Boston, MA (Remote)', config).apply);
});

test('blocks out-of-state locations with region skip reason', () => {
  const config = { search: { locationFilter: ['California', 'New York', 'Massachusetts'], jobFilter: {} } };
  const r = shouldApply('Data Scientist', 'Co', 'Seattle, WA (On-site)', config);
  assert(!r.apply);
  assert(r.skipReason.startsWith('location_no_match_region:'));
});

test('does not block when card location is missing', () => {
  const config = { search: { locationFilter: ['California'], jobFilter: {} } };
  assert(shouldApply('Data Scientist', 'Co', '', config).apply);
});

// ── Remote location matching (spec R2) ──
// 2,145 "United States (Remote)" jobs were skipped over 4 months despite
// includeRemote: true — the single largest inventory bug found.

test('passes US-remote job when includeRemote is true', () => {
  const config = { search: { includeRemote: true, locationFilter: ['California', 'New York', 'Massachusetts'], jobFilter: {} } };
  assert(shouldApply('Data Scientist', 'Co', 'United States (Remote)', config).apply);
});

test('passes remote location variants when includeRemote is true', () => {
  const config = { search: { includeRemote: true, locationFilter: ['California'], jobFilter: {} } };
  assert(shouldApply('Data Scientist', 'Co', 'Remote - United States', config).apply);
  assert(shouldApply('Data Scientist', 'Co', 'Anywhere in the United States', config).apply);
  assert(shouldApply('Data Scientist', 'Co', 'Texas, United States (Remote)', config).apply);
});

test('skips remote-only job with remote_disabled reason when includeRemote is false', () => {
  const config = { search: { includeRemote: false, locationFilter: ['California'], jobFilter: {} } };
  const r = shouldApply('Data Scientist', 'Co', 'United States (Remote)', config);
  assert(!r.apply);
  assert(r.skipReason.startsWith('location_no_match_remote_disabled:'));
});

test('allowlisted-state remote job passes via region even when includeRemote is false', () => {
  const config = { search: { includeRemote: false, locationFilter: ['California'], jobFilter: {} } };
  assert(shouldApply('Data Scientist', 'Co', 'San Francisco, CA (Remote)', config).apply);
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

test('detects the current Easy Apply limit dialog copy', () => {
  const msg = 'You reached today’s Easy Apply limit Great effort applying today. We limit Easy Apply submissions to help ensure each application gets the right attention. Save this job and continue applying tomorrow. Learn more Got it';
  assert(hasLinkedInDailySubmissionLimitMessage(msg));
});

test('does not match partial text', () => {
  assert(!hasLinkedInDailySubmissionLimitMessage('We limit daily submissions'));
  assert(!hasLinkedInDailySubmissionLimitMessage('Great effort applying today.'));
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

// ── analyzeSearchPageState (diagnostic for empty card list) ──
//
// Symptom we're guarding against: cron runs from 2026-04-26 onward all log
// `cardCount: 0` even though the same code applied 25–35 jobs on 2026-04-25.
// We can't keep flying blind — the diagnostic must tell us *why* a page has
// zero Easy Apply cards.

test('analyzeSearchPageState returns ok when easy-apply cards are present', () => {
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=data+scientist&f_AL=true',
    title: 'Data Scientist Jobs | LinkedIn',
    bodyText: '25 results. Easy Apply Stripe Data Scientist',
    easyApplyCardCount: 25,
    jobIdAttrCount: 25,
    jobLinkCount: 25,
    totalButtons: 60,
  });
  assert.strictEqual(r.kind, 'ok');
});

test('analyzeSearchPageState detects a login redirect', () => {
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/login?session_redirect=...',
    title: 'Sign In | LinkedIn',
    bodyText: 'Sign in or join now',
    easyApplyCardCount: 0,
    jobIdAttrCount: 0,
    jobLinkCount: 0,
    totalButtons: 4,
  });
  assert.strictEqual(r.kind, 'login_required');
});

test('analyzeSearchPageState detects an authwall login wall on the search URL', () => {
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=data+scientist',
    title: 'LinkedIn',
    bodyText: 'Sign in to see who has viewed your profile. Join now',
    easyApplyCardCount: 0,
    jobIdAttrCount: 0,
    jobLinkCount: 0,
    totalButtons: 5,
  });
  assert.strictEqual(r.kind, 'login_required');
});

test('analyzeSearchPageState detects a bot/security challenge', () => {
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/checkpoint/challenge/...',
    title: 'Security Verification | LinkedIn',
    bodyText: "Let's do a quick security check",
    easyApplyCardCount: 0,
    jobIdAttrCount: 0,
    jobLinkCount: 0,
    totalButtons: 3,
  });
  assert.strictEqual(r.kind, 'bot_challenge');
});

test('analyzeSearchPageState detects rate-limited page (daily cap message)', () => {
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=data+scientist&f_AL=true',
    title: 'Jobs | LinkedIn',
    bodyText: 'You reached today’s Easy Apply limit Great effort applying today. We limit Easy Apply submissions to help ensure each application gets the right attention. Save this job and continue applying tomorrow. Learn more',
    easyApplyCardCount: 0,
    jobIdAttrCount: 0,
    jobLinkCount: 0,
    totalButtons: 6,
  });
  assert.strictEqual(r.kind, 'rate_limited');
});

test('analyzeSearchPageState detects "no matching jobs" empty state', () => {
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=quantum+widget+wizard&f_AL=true',
    title: 'Jobs | LinkedIn',
    bodyText: 'No matching jobs found. Try removing a filter or expanding your search.',
    easyApplyCardCount: 0,
    jobIdAttrCount: 0,
    jobLinkCount: 0,
    totalButtons: 12,
  });
  assert.strictEqual(r.kind, 'no_results');
});

test('analyzeSearchPageState reports dom_changed when job links exist but Easy Apply selector is empty', () => {
  // This is exactly the scenario we suspect from 2026-04-26+: cards render
  // (job IDs and view links exist) but the role=button + "Easy Apply" text
  // selector finds nothing. We need a clear signal so the next iteration
  // knows the DOM moved.
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=data+scientist&f_AL=true',
    title: 'Jobs | LinkedIn',
    bodyText: 'Stripe Data Scientist Easy Apply 1d ago',
    easyApplyCardCount: 0,
    jobIdAttrCount: 25,
    jobLinkCount: 25,
    totalButtons: 70,
  });
  assert.strictEqual(r.kind, 'dom_changed');
});

test('analyzeSearchPageState reports unknown when nothing matches', () => {
  const r = analyzeSearchPageState({
    url: 'https://www.linkedin.com/jobs/search-results/?keywords=foo',
    title: 'Jobs | LinkedIn',
    bodyText: '',
    easyApplyCardCount: 0,
    jobIdAttrCount: 0,
    jobLinkCount: 0,
    totalButtons: 0,
  });
  assert.strictEqual(r.kind, 'unknown');
});

test('analyzeSearchPageState always returns a non-empty message string', () => {
  const states = [
    { kind: 'ok', s: { url: '', title: '', bodyText: '', easyApplyCardCount: 1, jobIdAttrCount: 0, jobLinkCount: 0, totalButtons: 1 } },
    { kind: 'login_required', s: { url: 'https://www.linkedin.com/login', title: '', bodyText: '', easyApplyCardCount: 0, jobIdAttrCount: 0, jobLinkCount: 0, totalButtons: 0 } },
    { kind: 'unknown', s: { url: '', title: '', bodyText: '', easyApplyCardCount: 0, jobIdAttrCount: 0, jobLinkCount: 0, totalButtons: 0 } },
  ];
  for (const { s } of states) {
    const r = analyzeSearchPageState(s);
    assert(typeof r.message === 'string' && r.message.length > 0, `kind=${r.kind} should have a message`);
  }
});

// ── pickCardStrategy (multi-strategy fallback) ──
//
// The original selector — getByRole('button').filter({hasText:'Easy Apply'}) —
// hasn't found a card since 2026-04-25. We need the agent to try alternatives
// before giving up: data-job-id elements, then `/jobs/view/{N}/` anchors.

test('pickCardStrategy prefers easy_apply_button when those cards exist', () => {
  const s = pickCardStrategy({ easyApplyCardCount: 25, jobIdAttrCount: 25, jobLinkCount: 25 });
  assert.strictEqual(s, 'easy_apply_button');
});

test('pickCardStrategy falls back to data_job_id when Easy Apply text is missing', () => {
  const s = pickCardStrategy({ easyApplyCardCount: 0, jobIdAttrCount: 25, jobLinkCount: 25 });
  assert.strictEqual(s, 'data_job_id');
});

test('pickCardStrategy falls back to job_link as a last resort', () => {
  const s = pickCardStrategy({ easyApplyCardCount: 0, jobIdAttrCount: 0, jobLinkCount: 25 });
  assert.strictEqual(s, 'job_link');
});

test('pickCardStrategy returns null when nothing card-like is present', () => {
  const s = pickCardStrategy({ easyApplyCardCount: 0, jobIdAttrCount: 0, jobLinkCount: 0 });
  assert.strictEqual(s, null);
});

test('pickCardStrategy treats missing counts as zero', () => {
  const s = pickCardStrategy({});
  assert.strictEqual(s, null);
});

// ── isJobCardText (discriminate cards from filter pills / nav buttons) ──
//
// Live diagnostic from 2026-04-30 dry-run captured the new card layout:
// cards are <div role="button"> elements whose accessible text reads like
//   "Data Scientist (Verified job) Data Scientist  H&R Block  Missouri,
//    United States (Remote)  Be an early applicant  ·  Posted 22 hours ago
//    ·   Apply"
// Filter pills ("LinkedIn Apply", "Past 24 hours") and nav buttons ("Jobs",
// "Messaging") are also role=button on the same page. We need a content
// classifier that tells job cards apart from those.

test('isJobCardText accepts a verified-job card', () => {
  const text = `Data Scientist (Verified job)\nData Scientist\nH&R Block\nMissouri, United States (Remote)\nBe an early applicant\n · \nPosted 22 hours ago\n · \n Apply`;
  assert.strictEqual(isJobCardText(text), true);
});

test('isJobCardText accepts a non-verified card with post-time + Apply', () => {
  const text = `Machine Learning Engineer\nMachine Learning Engineer\nEmonics LLC\nHouston, TX (On-site)\n · Posted 3 days ago\n · \n Apply`;
  assert.strictEqual(isJobCardText(text), true);
});

test('isJobCardText accepts a card with "Be an early applicant" + Apply', () => {
  const text = `Senior Data Engineer\nStripe\nSan Francisco, CA (Hybrid)\nBe an early applicant\n · \n Apply`;
  assert.strictEqual(isJobCardText(text), true);
});

test('isJobCardText rejects the LinkedIn Apply filter pill', () => {
  // The filter pill at the top of the search page is also role=button and
  // contains "Apply" — this is the false positive we have to exclude.
  assert.strictEqual(isJobCardText('LinkedIn Apply'), false);
});

test('isJobCardText rejects nav buttons', () => {
  assert.strictEqual(isJobCardText('Jobs'), false);
  assert.strictEqual(isJobCardText('Messaging'), false);
  assert.strictEqual(isJobCardText('Notifications'), false);
});

test('isJobCardText rejects bare "Apply" buttons', () => {
  assert.strictEqual(isJobCardText('Apply'), false);
  assert.strictEqual(isJobCardText(' Apply '), false);
});

test('isJobCardText rejects empty / null text', () => {
  assert.strictEqual(isJobCardText(''), false);
  assert.strictEqual(isJobCardText(null), false);
  assert.strictEqual(isJobCardText(undefined), false);
});

test('isJobCardText rejects "Past 24 hours" filter button', () => {
  assert.strictEqual(isJobCardText('Past 24 hours'), false);
});

test('isJobCardText rejects "How promoted jobs are ranked" tooltip trigger', () => {
  assert.strictEqual(isJobCardText('How promoted jobs are ranked'), false);
});

test('isJobCardText accepts a card text with promoted source', () => {
  const text = `Promoted by hirer\nData Analyst\nData Analyst\nMatricstek Inc.\nUnited States\nBe an early applicant\n · Apply`;
  assert.strictEqual(isJobCardText(text), true);
});

// ── Apply-link aria-label registry ──
//
// 2026-04-30 probe of the redesigned detail panel found:
//   <a aria-label="LinkedIn Apply to this job"
//      href=".../jobs/view/{N}/apply/?openSDUIApplyFlow=true&...">Apply</a>
// The legacy aria-label "Easy Apply to this job" no longer exists. The DB
// shows 34 cards skipped with reason `no_easy_apply_button` in the dry-run
// — every one of them an actual Easy-Apply job whose link the old selector
// missed. We register the new label, keep the old label as a fallback in
// case LinkedIn is mid-rollout, and pin both via a test so a future selector
// migration can't silently regress.

test('APPLY_LINK_ARIA_LABELS contains the 2026-04-26 LinkedIn Apply variant', () => {
  assert(Array.isArray(APPLY_LINK_ARIA_LABELS), 'APPLY_LINK_ARIA_LABELS must be an array');
  assert(APPLY_LINK_ARIA_LABELS.includes('LinkedIn Apply to this job'),
    `expected "LinkedIn Apply to this job" in APPLY_LINK_ARIA_LABELS, got ${JSON.stringify(APPLY_LINK_ARIA_LABELS)}`);
});

test('APPLY_LINK_ARIA_LABELS keeps the legacy "Easy Apply to this job" as fallback', () => {
  assert(APPLY_LINK_ARIA_LABELS.includes('Easy Apply to this job'),
    `expected "Easy Apply to this job" still listed for legacy compatibility`);
});

test('APPLY_LINK_ARIA_LABELS prioritizes the new label over the legacy one', () => {
  // Lookup order matters — both for readability and so that any code which
  // .find()s the first-matching record returns the live aria-label first.
  const newIdx = APPLY_LINK_ARIA_LABELS.indexOf('LinkedIn Apply to this job');
  const legacyIdx = APPLY_LINK_ARIA_LABELS.indexOf('Easy Apply to this job');
  assert(newIdx >= 0 && legacyIdx >= 0);
  assert(newIdx < legacyIdx, 'new label should be listed before legacy');
});

test('buildApplyLinkSelector emits a comma-separated CSS selector covering all aria-labels', () => {
  const sel = buildApplyLinkSelector();
  assert.strictEqual(typeof sel, 'string');
  assert(sel.includes('a[aria-label="LinkedIn Apply to this job"]'));
  assert(sel.includes('a[aria-label="Easy Apply to this job"]'));
  // Should be a valid multi-selector
  assert(sel.split(',').length >= 2);
});

test('buildApplyLinkSelector matches the 2026-08-13 BUTTON variant of the apply control', () => {
  // LinkedIn replaced the apply <a href=".../apply/..."> with
  // <button aria-label="Easy Apply to this job">Easy Apply</button>
  // (probe 2026-08-21). Anchor-only matching produced 9 days of
  // no_easy_apply_button on every job (zero submissions 08-13 → 08-21).
  const sel = buildApplyLinkSelector();
  assert(sel.includes('button[aria-label="Easy Apply to this job"]'));
  assert(sel.includes('button[aria-label="LinkedIn Apply to this job"]'));
  // The external-apply control must never match.
  assert(!sel.includes('Apply on company website'));
});

test('education rank maps only explicit thresholds to Yes', () => {
  assert.strictEqual(
    mapEducationAnswerToYesNo('Do you have at least a bachelor degree?', "Master's Degree"),
    'Yes'
  );
  assert.strictEqual(
    mapEducationAnswerToYesNo('Is an associate degree your highest education level?', "Master's Degree"),
    'No'
  );
  assert.strictEqual(
    mapEducationAnswerToYesNo('Do you have a bachelor degree?', "Master's Degree"),
    null
  );
});

test('dialog option matching does not confuse short numeric choices', () => {
  const options = ['0', '1', '2', '10+'].map((label) => ({ label }));
  assert.strictEqual(matchDialogRadioOption(options, '10'), null);
  assert.strictEqual(matchDialogRadioOption(options, '1').label, '1');
  assert.strictEqual(matchDialogRadioOption(options, '10+').label, '10+');
});

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
