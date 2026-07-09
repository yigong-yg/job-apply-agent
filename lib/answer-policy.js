'use strict';

// Answer policy guard (spec R7/R8): classify screener questions and decide
// whether automation may answer at all. Guarded classes answer ONLY from
// exact user config; they never fall through to fuzzy matching, generic
// rules, LLM generation, or safe defaults.

function normalize(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9+/\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Negated/trap phrasings of otherwise-answerable questions. Auto-answering
// these inverts meaning, so guarded classes always block on them.
const NEGATION_RE = /\b(unable|not able|cannot|can not|excluded|restricted|prohibited|ineligible)\b|if yes[, ]*(please )?stop/;

const HONEYPOT_RE = /\b(list comprehension|write a (function|program|query|script|regex)|code snippet|prove you are (a )?human|are you a robot|captcha|solve (this|the) (puzzle|problem)|what is \d+ \s*\+\s*\d+)\b/;

// Ordered: first match wins. Sanctions before citizenship so combined
// questions route to the stricter class.
const CLASS_RULES = [
  { questionClass: 'honeypot', re: HONEYPOT_RE },
  { questionClass: 'citizenship_sanctions', re: /\b(cuba|iran|north korea|syria|sanction(ed|s)?)\b/ },
  { questionClass: 'military_veteran', re: /\b(military|veterans?|armed forces)\b/ },
  { questionClass: 'sensitive_identity', re: /\b(eeo|equal opportunity|disability|disabled|gender|race|ethnicity|sexual orientation|lgbtq)\b/ },
  { questionClass: 'security_clearance', re: /\bclearance\b/ },
  { questionClass: 'legal_employment', re: /\b(non compet\w*|noncompete|non solicit\w*|felony|convicted|criminal|misdemeanor|terminated|termination|disciplinary)\b/ },
  { questionClass: 'employee_referral', re: /current\w* (a |an )?\w*\s*employee|employee of|previously (been )?employed|former employee|\b(referred|referral)\b.*\b(name|contact|who)\b/ },
  { questionClass: 'education_facts', re: /\b(school|university|college|graduation|graduated|gpa|grade point|degree|education)\b/ },
  { questionClass: 'citizenship', re: /\b(citizen(ship)?|permanent resident|green card)\b/ },
  { questionClass: 'sponsorship', re: /\bsponsor\w*\b/ },
  { questionClass: 'work_authorization', re: /authorized to work|legally authorized|eligible to work|legal right to work|work authorization|lawfully work|\b(un)?able to (lawfully )?work\b/ },
];

function classifyQuestion(rawLabel) {
  const label = normalize(rawLabel);
  if (!label) return { questionClass: 'unknown', guarded: false };
  for (const { questionClass, re } of CLASS_RULES) {
    if (re.test(label)) return { questionClass, guarded: true };
  }
  return { questionClass: 'unguarded', guarded: false };
}

// Exact-equality lookup against the user's explicit Q→A map. This is NOT
// fuzzy matching: the normalized label must equal a normalized key.
function exactDefaultAnswer(label, defaultAnswers) {
  for (const [key, value] of Object.entries(defaultAnswers || {})) {
    if (normalize(key) === label && String(value).trim() !== '') {
      return { answer: String(value), source: `config:defaultAnswers.${key}` };
    }
  }
  return null;
}

function isNegativeVeteranStatus(veteranStatus) {
  return /not a (protected )?veteran|^no\b|not (a )?veteran|never served/i.test(veteranStatus || '');
}

// Per-class resolution from explicit config facts. Returns {answer, source}
// or null when no configured fact covers the question.
function resolveFromConfig(questionClass, label, config, defaultAnswers) {
  const user = (config || {}).user || {};

  switch (questionClass) {
    case 'work_authorization':
      if (user.workAuthorization) {
        return { answer: 'Yes', source: 'config:user.workAuthorization' };
      }
      return null;

    case 'sponsorship':
      if (typeof user.requiresSponsorship === 'boolean') {
        return { answer: user.requiresSponsorship ? 'Yes' : 'No', source: 'config:user.requiresSponsorship' };
      }
      return null;

    case 'citizenship':
      if (/us citizen/i.test(user.workAuthorization || '')) {
        return { answer: 'Yes', source: 'config:user.workAuthorization' };
      }
      return null;

    case 'military_veteran': {
      // Self-identification blobs are never auto-answered.
      if (/self identify/.test(label) || label.length > 150) return null;
      if (!/\bveteran\b/.test(label)) return null; // "served in the military" needs its own config fact
      if (!user.veteranStatus) return null;
      const yesNoForm = /^(are|have|were|do|did) you\b/.test(label);
      if (yesNoForm) {
        return isNegativeVeteranStatus(user.veteranStatus)
          ? { answer: 'No', source: 'config:user.veteranStatus' }
          : null; // affirmative veteran status: statement forms only, never derived Yes
      }
      return { answer: user.veteranStatus, source: 'config:user.veteranStatus' };
    }

    case 'sensitive_identity':
      if (/\b(eeo|equal opportunity)\b/.test(label)) return null; // disclosure blobs: block
      if (/disab/.test(label) && user.disabilityStatus) {
        return { answer: user.disabilityStatus, source: 'config:user.disabilityStatus' };
      }
      if (/\bgender\b/.test(label) && user.gender) {
        return { answer: user.gender, source: 'config:user.gender' };
      }
      if (/\b(race|ethnicity)\b/.test(label) && user.race) {
        return { answer: user.race, source: 'config:user.race' };
      }
      return null;

    case 'education_facts':
      if (/\b(gpa|grade point)\b/.test(label) && defaultAnswers && defaultAnswers.gpa) {
        return { answer: String(defaultAnswers.gpa), source: 'config:defaultAnswers.gpa' };
      }
      if (/\b(graduation|graduated)\b/.test(label)) {
        return user.graduationYear
          ? { answer: String(user.graduationYear), source: 'config:user.graduationYear' }
          : null;
      }
      if (/\b(school|university|college)\b/.test(label) && !/\bdegree|education\b/.test(label)) {
        return user.school
          ? { answer: String(user.school), source: 'config:user.school' }
          : null;
      }
      if (/highest.*(education|degree)|education level|level of education/.test(label) && user.highestEducation) {
        return { answer: user.highestEducation, source: 'config:user.highestEducation' };
      }
      return null;

    default:
      // honeypot, citizenship_sanctions, security_clearance (non-exact),
      // legal_employment, employee_referral: no config fact can cover these.
      return null;
  }
}

/**
 * Decide whether automation may answer this question.
 *
 * @param {string} rawLabel - the form question text
 * @param {{config: object, defaultAnswers: object}} ctx
 * @returns {{action: 'proceed'}
 *         | {action: 'answer', answer: string, source: string, questionClass: string}
 *         | {action: 'block', questionClass: string, reason: string}}
 */
function guardAnswer(rawLabel, ctx = {}) {
  const { questionClass, guarded } = classifyQuestion(rawLabel);
  if (!guarded) return { action: 'proceed', questionClass };

  const label = normalize(rawLabel);

  if (questionClass === 'honeypot') {
    return { action: 'block', questionClass, reason: 'honeypot' };
  }
  if (questionClass === 'citizenship_sanctions') {
    return { action: 'block', questionClass, reason: 'sanctions_never_auto' };
  }
  if (NEGATION_RE.test(label)) {
    return { action: 'block', questionClass, reason: 'negated_guarded' };
  }

  // Strongest config: the user's own exact Q→A entry.
  const exact = exactDefaultAnswer(label, (ctx.defaultAnswers || {}));
  if (exact) return { action: 'answer', ...exact, questionClass };

  const resolved = resolveFromConfig(questionClass, label, ctx.config, ctx.defaultAnswers);
  if (resolved) return { action: 'answer', ...resolved, questionClass };

  return { action: 'block', questionClass, reason: 'guarded_no_config' };
}

// Regex sources for in-page (shadow DOM) guarded-question detection.
// page.evaluate() cannot import this module, so callers pass these sources
// in and rebuild the RegExps inside the page. Keep the page-side normalize
// in sync with normalize() above.
const GUARDED_PATTERN_SOURCES = CLASS_RULES.map((r) => r.re.source);

module.exports = { classifyQuestion, guardAnswer, normalize, GUARDED_PATTERN_SOURCES };
