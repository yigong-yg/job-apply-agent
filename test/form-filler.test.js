'use strict';

const assert = require('assert');
const { inferByRules, normalizeLabel } = require('../lib/form-filler');

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

const config = {
  user: {
    firstName: 'Sam',
    city: 'Springfield',
    state: 'IL',
    zipCode: '12345',
    desiredSalary: '120000',
    startDate: 'Immediately',
    email: 'test@example.com',
    phone: '5551234567',
    linkedinUrl: 'https://www.linkedin.com/in/test',
    workAuthorization: 'US Citizen',
    requiresSponsorship: false,
    veteranStatus: 'No',
    disabilityStatus: 'Prefer not to say',
    gender: 'Male',
    race: 'Prefer not to say',
    yearsOfExperience: '3',
  },
};

console.log('\n=== Form Filler Tests ===\n');

test('preferred name does not trigger hear_about rule', () => {
  const result = inferByRules(normalizeLabel('What is your preferred name?'), 'What is your preferred name?', 'text', config);
  assert(result);
  assert.strictEqual(result.rule, 'rule:preferred_name');
  assert.strictEqual(result.answer, 'Sam');
});

test('graduation year is NOT invented by the rule tier (guard owns it)', () => {
  // v2 spec R8: exact graduation year answers only from config.user.graduationYear
  // via the answer-policy guard. Deriving it from years-of-experience produced
  // three different graduation years across submitted applications.
  const result = inferByRules(
    normalizeLabel('Please provide your graduation Year for your highest completed degree.'),
    'Please provide your graduation Year for your highest completed degree.',
    'text',
    config
  );
  assert.strictEqual(result, null);
});

test('percentage questions are NOT answered with an invented number', () => {
  // v2 spec R10: arbitrary numbers are a fabrication class, not a safe default.
  const result = inferByRules(
    normalizeLabel('What percentage of your development time is spent in AI tools?'),
    'What percentage of your development time is spent in AI tools?',
    'text',
    config
  );
  assert.strictEqual(result, null);
});

test('commute question answers Yes via rule (stable preference)', () => {
  // Highest-volume required radio ("Are you comfortable commuting to this
  // job's location?"). The user's own defaultAnswers attest Yes to commute
  // questions; the rule generalizes the phrasing so the radio never falls
  // through to an unfilled required field.
  const result = inferByRules(
    normalizeLabel("Are you comfortable commuting to this job's location?"),
    "Are you comfortable commuting to this job's location?",
    'radio',
    config
  );
  assert(result);
  assert.strictEqual(result.rule, 'rule:commute');
  assert.strictEqual(result.answer, 'Yes');
});

test('residency-fact commute questions are NOT answered Yes', () => {
  // Submitted fabrications from July: blanket commute-Yes claimed the user
  // currently lives near Brea and Calabasas, CA. Residency facts must fall
  // through to the LLM/cannot_fill, which answer from the real location.
  const labels = [
    'Please confirm you currently reside within a commutable distance to Brea, CA.',
    'This role is fully on-site five days per week. Do you currently live within a commutable distance to Calabasas?',
    'If you are not currently located within a reasonable commuting distance of the job location, are you willing to relocate at your own expense?',
  ];
  for (const label of labels) {
    const result = inferByRules(normalizeLabel(label), label, 'radio', config);
    assert(!result || result.rule !== 'rule:commute', `expected no commute-Yes for: ${label}`);
  }
});

test('gpa is NOT invented by the rule tier (guard owns it)', () => {
  const result = inferByRules(
    normalizeLabel('What is your GPA?'), 'What is your GPA?', 'text', config
  );
  assert.strictEqual(result, null);
});

test('experience-with and able-to-work claims are NOT polarity-Yes', () => {
  // 'experience with' / 'able to work' are fact claims: polarity Yes
  // fabricated "3+ years LangChain/RAG" and NY-office availability.
  const skill = inferByRules(
    normalizeLabel('Do you have experience with Bloomberg tick data?'),
    'Do you have experience with Bloomberg tick data?', 'radio', config
  );
  assert(!skill || skill.rule !== 'rule:polarity_yes');
  const office = inferByRules(
    normalizeLabel('Are you able to work in-person up to 3 days a week in our New York office?'),
    'Are you able to work in-person up to 3 days a week in our New York office?', 'radio', config
  );
  assert(!office || office.rule !== 'rule:polarity_yes');
});

test('hear about rule still matches an actual referral question', () => {
  const result = inferByRules(
    normalizeLabel('How did you hear about us or were you referred?'),
    'How did you hear about us or were you referred?',
    'text',
    config
  );
  assert(result);
  assert.strictEqual(result.rule, 'rule:hear_about');
  assert.strictEqual(result.answer, 'Job Board');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
