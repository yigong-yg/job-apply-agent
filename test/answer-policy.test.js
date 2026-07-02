'use strict';

// Red-team regression suite from .docs/pm-spec-quality-first-agent-2026-07-01.md §10.3.
// Guarded question classes must never be answered by fuzzy/LLM/safe_default fallbacks:
// they answer from exact config or block.

const assert = require('assert');
const { classifyQuestion, guardAnswer } = require('../lib/answer-policy');

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
    lastName: 'Doe',
    email: 'test@example.com',
    city: 'Salt Lake City',
    state: 'UT',
    workAuthorization: 'US Citizen',
    requiresSponsorship: false,
    veteranStatus: 'I am not a protected veteran',
    disabilityStatus: 'I do not wish to answer',
    gender: 'Male',
    race: 'Prefer not to say',
    yearsOfExperience: '3',
    highestEducation: "Master's Degree",
  },
};

const defaultAnswers = {
  'do you have a security clearance': 'No',
  'gpa': '3.8',
};

const ctx = { config, defaultAnswers };

console.log('\n=== Answer Policy Tests ===\n');

// ── Classification ──

test('classifies military question as guarded', () => {
  const c = classifyQuestion('Have you ever served in the military? Select one of the following:');
  assert.strictEqual(c.guarded, true);
  assert.strictEqual(c.questionClass, 'military_veteran');
});

test('classifies sanctions question as guarded', () => {
  const c = classifyQuestion('Are you a national, citizen, or permanent resident of Cuba, Iran, North Korea, or Syria?');
  assert.strictEqual(c.guarded, true);
  assert.strictEqual(c.questionClass, 'citizenship_sanctions');
});

test('classifies plain experience question as unguarded', () => {
  const c = classifyQuestion('How many years of experience do you have with Python?');
  assert.strictEqual(c.guarded, false);
});

test('classifies email as unguarded profile fact', () => {
  assert.strictEqual(classifyQuestion('Email address').guarded, false);
});

// ── Guarded blocks (no config fact exists) ──

test('blocks military service question instead of guessing', () => {
  const r = guardAnswer('Have you ever served in the military? Select one of the following:', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks sanctions-country residency question', () => {
  const r = guardAnswer('Are you a national, citizen, or permanent resident of Cuba, Iran, North Korea, or Syria?', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks protected-veteran self-identification blob', () => {
  const r = guardAnswer('VETERANS INVITATION TO SELF-IDENTIFY Regulations issued by the Department of Labor...', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks non-compete question', () => {
  const r = guardAnswer('Do you have an active non-competition or employment agreement?', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks current-employee trap question', () => {
  const r = guardAnswer('Are you a current NielsenIQ employee? If yes, please stop here.', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks former-employee question', () => {
  const r = guardAnswer('Have you previously been employed by this company?', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks school selection with no configured school', () => {
  const r = guardAnswer('School', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks graduation year with no configured graduationYear', () => {
  const r = guardAnswer('Please provide your graduation Year for your highest completed degree', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks referral-name question', () => {
  const r = guardAnswer('Were you referred to us? If yes, please provide the name of the contact.', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks negated authorization question (polarity trap)', () => {
  const r = guardAnswer('Are you UNABLE to work in the United States?', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks criminal-history question', () => {
  const r = guardAnswer('Have you ever been convicted of a felony?', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks EEO disclosure blob', () => {
  const r = guardAnswer('EEO Information We are an equal opportunity employer and all qualified applicants will receive consideration', ctx);
  assert.strictEqual(r.action, 'block');
});

test('blocks code-writing honeypot', () => {
  const r = guardAnswer('Write a list comprehension that returns a list of numbers 0-10', ctx);
  assert.strictEqual(r.action, 'block');
  assert.strictEqual(r.questionClass, 'honeypot');
});

test('blocks prove-you-are-human honeypot', () => {
  const r = guardAnswer('To prove you are human, what is 3 + 4?', ctx);
  assert.strictEqual(r.action, 'block');
});

// ── Guarded answers from exact config ──

test('answers work authorization from config', () => {
  const r = guardAnswer('Are you legally authorized to work in the United States?', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'Yes');
  assert.match(r.source, /config/);
});

test('answers sponsorship No from config.requiresSponsorship=false', () => {
  const r = guardAnswer('Do you now or will you in the future require sponsorship for employment visa status?', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'No');
});

test('answers US citizen Yes from workAuthorization', () => {
  const r = guardAnswer('Are you a U.S. citizen?', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'Yes');
});

test('answers are-you-a-veteran No from veteranStatus', () => {
  const r = guardAnswer('Are you a veteran?', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'No');
});

test('answers veteran-status select with configured statement', () => {
  const r = guardAnswer('Veteran status', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'I am not a protected veteran');
});

test('answers disability status with configured statement', () => {
  const r = guardAnswer('Disability status', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'I do not wish to answer');
});

test('answers gender from config', () => {
  const r = guardAnswer('Gender', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'Male');
});

test('answers security clearance from exact defaultAnswers key', () => {
  const r = guardAnswer('Do you have a security clearance?', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, 'No');
});

test('answers GPA from exact defaultAnswers key', () => {
  const r = guardAnswer('What is your GPA?', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, '3.8');
});

test('answers highest education level from config', () => {
  const r = guardAnswer('What is your highest level of education?', ctx);
  assert.strictEqual(r.action, 'answer');
  assert.strictEqual(r.answer, "Master's Degree");
});

test('blocks clearance question when defaultAnswers lacks the key', () => {
  const r = guardAnswer('Do you have an active TS/SCI clearance?', { config, defaultAnswers: {} });
  assert.strictEqual(r.action, 'block');
});

test('blocks veteran question when config lacks veteranStatus', () => {
  const bare = { config: { user: {} }, defaultAnswers: {} };
  const r = guardAnswer('Are you a veteran?', bare);
  assert.strictEqual(r.action, 'block');
});

// ── Unguarded questions proceed to normal tiers ──

test('proceeds on years-of-experience question', () => {
  const r = guardAnswer('How many years of experience do you have with Python?', ctx);
  assert.strictEqual(r.action, 'proceed');
});

test('proceeds on salary question', () => {
  const r = guardAnswer('What is your expected salary?', ctx);
  assert.strictEqual(r.action, 'proceed');
});

test('proceeds on hear-about-us question', () => {
  const r = guardAnswer('How did you hear about us?', ctx);
  assert.strictEqual(r.action, 'proceed');
});

test('proceeds on commute question', () => {
  const r = guardAnswer("Are you comfortable commuting to this job's location?", ctx);
  assert.strictEqual(r.action, 'proceed');
});

test('proceeds on empty label', () => {
  const r = guardAnswer('', ctx);
  assert.strictEqual(r.action, 'proceed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
