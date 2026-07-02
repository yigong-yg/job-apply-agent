'use strict';

// Output validation guard (spec R11): every candidate answer passes this
// before it touches the DOM. Encodes the real leak classes found in the
// 2026-07-01 investigation.

const assert = require('assert');
const { validateAnswer } = require('../lib/output-validator');

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

console.log('\n=== Output Validator Tests ===\n');

// ── Placeholder leaks (48 submitted in production) ──

test('rejects bracket placeholder [PORTFOLIO_URL]', () => {
  const r = validateAnswer('[PORTFOLIO_URL]', { label: 'Website' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'placeholder');
});

test('rejects embedded placeholder in URL', () => {
  const r = validateAnswer('https://linkedin.com/in/[HANDLE]', { label: 'LinkedIn Profile' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'placeholder');
});

test('rejects [ZIP] placeholder', () => {
  assert.strictEqual(validateAnswer('[ZIP]', { label: 'Postal' }).ok, false);
});

test('accepts an answer with legitimate brackets in prose', () => {
  const r = validateAnswer('Built ML pipelines (Python) for 3 years', { label: 'Experience summary' });
  assert.strictEqual(r.ok, true);
});

// ── Markdown / code fences (bot-honeypot tell) ──

test('rejects markdown code fence', () => {
  const r = validateAnswer('Here you go:\n```python\n[x for x in range(11)]\n```', { label: 'Write a list comprehension' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'markdown');
});

test('rejects markdown bold/heading formatting', () => {
  const r = validateAnswer('**Strong** experience with:\n## Skills', { label: 'Summary' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'markdown');
});

// ── Meta/AI answers ──

test('rejects as-an-AI meta answer', () => {
  const r = validateAnswer('As an AI language model, I cannot answer that', { label: 'Why us?' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'meta_answer');
});

// ── Type mismatches ──

test('rejects non-numeric answer for numeric input', () => {
  const r = validateAnswer('Yes', { label: 'Years of experience with Python', inputType: 'number' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'type_mismatch');
});

test('accepts numeric answer for numeric input', () => {
  assert.strictEqual(validateAnswer('3', { label: 'Years', inputType: 'number' }).ok, true);
});

test('rejects salary bleeding into numeric-looking notice period', () => {
  // real case: "expected notice period?" fuzzy-matched salary "120000"
  const r = validateAnswer('120000', { label: 'What is your expected notice period in weeks?', inputType: 'number' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'implausible_magnitude');
});

test('rejects non-URL answer for url input', () => {
  const r = validateAnswer('my portfolio', { label: 'Portfolio', inputType: 'url' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'type_mismatch');
});

test('accepts URL answer for url input', () => {
  assert.strictEqual(validateAnswer('https://example.com/me', { label: 'Portfolio', inputType: 'url' }).ok, true);
});

// ── Generic fallback on factual questions ──

test('rejects interview-fallback text for a factual question', () => {
  const r = validateAnswer(
    "I'd welcome the opportunity to discuss this in detail during an interview.",
    { label: 'Which cloud platforms have you deployed production AI workloads on?' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'generic_fallback');
});

// ── Length limits ──

test('rejects over-length answer for short text field', () => {
  const r = validateAnswer('x'.repeat(1200), { label: 'Current title', fieldType: 'text' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too_long');
});

test('accepts long answer for textarea', () => {
  const r = validateAnswer('a solid paragraph. '.repeat(30), { label: 'Tell us about yourself', fieldType: 'textarea' });
  assert.strictEqual(r.ok, true);
});

// ── Empty/degenerate ──

test('rejects empty answer', () => {
  assert.strictEqual(validateAnswer('', { label: 'City' }).ok, false);
});

test('rejects null answer', () => {
  assert.strictEqual(validateAnswer(null, { label: 'City' }).ok, false);
});

test('accepts a normal answer', () => {
  const r = validateAnswer('Springfield', { label: 'City' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.answer, 'Springfield');
});

test('trims surrounding whitespace on accept', () => {
  const r = validateAnswer('  Springfield  ', { label: 'City' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.answer, 'Springfield');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
