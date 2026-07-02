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
    city: 'Salt Lake City',
    state: 'UT',
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

test('graduation year gets a numeric answer', () => {
  const currentYear = new Date().getUTCFullYear();
  const result = inferByRules(
    normalizeLabel('Please provide your graduation Year for your highest completed degree.'),
    'Please provide your graduation Year for your highest completed degree.',
    'text',
    config
  );
  assert(result);
  assert.strictEqual(result.rule, 'rule:graduation_year');
  assert.strictEqual(result.answer, String(currentYear - 3));
});

test('percentage questions get a decimal-safe numeric answer', () => {
  const result = inferByRules(
    normalizeLabel('What percentage of your development time is spent in AI tools?'),
    'What percentage of your development time is spent in AI tools?',
    'text',
    config
  );
  assert(result);
  assert.strictEqual(result.rule, 'rule:percentage_numeric');
  assert.strictEqual(result.answer, '50.0');
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
