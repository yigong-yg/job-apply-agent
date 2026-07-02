'use strict';

// Output validation guard (spec R11). Last line of defense before an answer
// touches the DOM: rejects the leak classes observed in production
// (placeholder tokens, markdown-fenced code, meta/AI text, type mismatches,
// generic fallback prose on factual questions, over-length values).

const PLACEHOLDER_RE = /\[[A-Z][A-Z0-9_]*\]/;
const MARKDOWN_RE = /```|(^|\n)#{1,6}\s|\*\*[^*\n]+\*\*/;
const META_ANSWER_RE = /\bas an ai\b|\blanguage model\b|\bi am an ai\b|\bi cannot assist\b/i;
const GENERIC_FALLBACK_RE = /welcome the opportunity to discuss/i;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const URL_RE = /^https?:\/\/\S+\.\S+/i;

// Small-unit quantities (weeks of notice, years of experience) should never
// carry salary-sized magnitudes — the classic salary-into-notice-period bleed.
const SMALL_UNIT_LABEL_RE = /\b(notice|weeks?|days?|months?|years?|hours?)\b/;
const MONEY_LABEL_RE = /\b(salary|compensation|pay|rate|wage|amount)\b/;

const LENGTH_LIMITS = {
  text: 500,
  select: 300,
  radio: 300,
  checkbox: 300,
  textarea: 3000,
  default: 1000,
};

/**
 * Validate a candidate answer before filling it into a form field.
 *
 * @param {string|null} answer
 * @param {{label?: string, fieldType?: string, inputType?: string}} field
 * @returns {{ok: true, answer: string} | {ok: false, reason: string}}
 */
function validateAnswer(answer, field = {}) {
  if (answer === null || answer === undefined) return { ok: false, reason: 'empty' };
  const value = String(answer).trim();
  if (value === '') return { ok: false, reason: 'empty' };

  const label = String(field.label || '').toLowerCase();

  if (PLACEHOLDER_RE.test(value)) return { ok: false, reason: 'placeholder' };
  if (MARKDOWN_RE.test(value)) return { ok: false, reason: 'markdown' };
  if (META_ANSWER_RE.test(value)) return { ok: false, reason: 'meta_answer' };
  if (GENERIC_FALLBACK_RE.test(value)) return { ok: false, reason: 'generic_fallback' };

  if (field.inputType === 'number') {
    if (!NUMERIC_RE.test(value)) return { ok: false, reason: 'type_mismatch' };
    const magnitude = Math.abs(parseFloat(value));
    if (magnitude > 1000 && SMALL_UNIT_LABEL_RE.test(label) && !MONEY_LABEL_RE.test(label)) {
      return { ok: false, reason: 'implausible_magnitude' };
    }
  }

  if (field.inputType === 'url' && !URL_RE.test(value)) {
    return { ok: false, reason: 'type_mismatch' };
  }

  const limit = LENGTH_LIMITS[field.fieldType] || LENGTH_LIMITS.default;
  if (value.length > limit) return { ok: false, reason: 'too_long' };

  return { ok: true, answer: value };
}

module.exports = { validateAnswer };
