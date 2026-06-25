'use strict';

const assert = require('assert');
const {
  normalizeLabel,
  inferByRules,
  coerceNumericAnswer,
  prepareTextAnswer,
} = require('../lib/form-filler');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    failed++;
  }
}

const config = {
  user: {
    firstName: 'First',
    middleName: 'M',
    lastName: 'Last',
    preferredName: 'Preferred First',
    graduationYear: '2024',
    yearsOfExperience: '4',
    desiredSalary: '$150,000',
    defaultPercentageAnswer: '60',
    currentEmployer: 'N/A',
    githubUrl: 'https://github.com/example',
    website: 'https://example.com',
  },
};

function infer(label, fieldType = 'text') {
  return inferByRules(normalizeLabel(label), label, fieldType, config);
}

test('preferred name does not match referred/hear-about rule', () => {
  const result = infer('Preferred Name');
  assert.strictEqual(result.answer, 'Preferred First');
  assert.strictEqual(result.rule, 'rule:preferred_name');
});

test('preferred first and last name use user identity fields', () => {
  assert.strictEqual(infer('Preferred First Name').answer, 'First');
  assert.strictEqual(infer('Preferred Last Name').answer, 'Last');
});

test('graduation year and percentage questions use numeric config-backed answers', () => {
  assert.strictEqual(infer('Please provide your graduation Year for your highest completed degree.').answer, '2024');
  assert.strictEqual(infer('What percentage of your development time is spent in AI tools?').answer, '60');
});

test('salary variants use desired salary', () => {
  assert.strictEqual(infer('What are your desired base salary expectations?').answer, '$150,000');
  assert.strictEqual(infer('Desired pay expectations').answer, '$150,000');
});

test('current employer and profile URL rules cover common employer forms', () => {
  assert.strictEqual(infer('Current Employer (if applicable)').answer, 'N/A');
  assert.strictEqual(infer('Most Recent Employer').answer, 'N/A');
  assert.strictEqual(infer('Please provide your Github username').answer, 'https://github.com/example');
  assert.strictEqual(infer('Website').answer, 'https://example.com');
});

test('numeric coercion strips currency, percent signs, and commas', () => {
  assert.strictEqual(coerceNumericAnswer('$150,000'), '150000');
  assert.strictEqual(coerceNumericAnswer('60%'), '60');
  assert.strictEqual(coerceNumericAnswer('4 years'), '4');
  assert.strictEqual(coerceNumericAnswer('Master of Science'), null);
});

test('numeric questions reject prose and format number inputs for LinkedIn', () => {
  const graduation = normalizeLabel('Please provide your graduation Year for your highest completed degree.');
  const years = normalizeLabel('How many years of customer-facing AI/ML roles do you have?');
  assert.strictEqual(prepareTextAnswer('Master of Science', graduation, 'text'), null);
  assert.strictEqual(prepareTextAnswer('2024', graduation, 'text'), '2024');
  assert.strictEqual(prepareTextAnswer('4', years, 'number'), '4.0');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
