'use strict';

/**
 * LinkedIn Easy Apply Module — New UI (2026-04)
 *
 * Targets /jobs/search-results/ with inline SDUI apply flow.
 *
 * DOM architecture (verified via Playwright 2026-04-10):
 *   - Card list + detail panel: TOP-LEVEL PAGE (not inside any iframe)
 *   - Apply form (after clicking Easy Apply): SHADOW DOM inside #interop-outlet
 *   - /preload/ iframe exists but is just a shell — not used for cards or forms
 *
 * Flow:
 *   page.goto(searchUrl)
 *   → listResultCards(page) → card locators (role=button on top-level page)
 *   → summarizeResultCard(card) → {title, company, ...}
 *   → selectCard(card) → detail loads on page
 *   → extractSelectedJobDetail(page) → {jobId, isPromoted, easyApplyHref, ...}
 *   → enterEasyApply(page) → click <a> link, form renders in shadow DOM
 *   → handleInlineApplyStep(page, ...) → fill via shadow root, click via shadow root
 */

const path = require('path');
const fs = require('fs');
const { sleep } = require('../lib/humanize');
const { fillForm, retryInvalidFields } = require('../lib/form-filler');
const { recordUnfilledField, recordFillAudit } = require('../lib/state');
const { queueAppNotification } = require('../lib/notify');
const { guardAnswer, GUARDED_PATTERN_SOURCES } = require('../lib/answer-policy');
const { validateAnswer, VALIDATOR_PATTERN_SOURCES } = require('../lib/output-validator');

const SELECTOR_TIMEOUT = 10000;

// ── Apply-link aria-labels ──
//
// LinkedIn renamed the apply-link aria-label from "Easy Apply to this job"
// to "LinkedIn Apply to this job" as part of the same redesign that broke
// card discovery (probe captured 2026-04-30 — the new link is an
// <a aria-label="LinkedIn Apply to this job"
//    href=".../jobs/view/{N}/apply/?openSDUIApplyFlow=true&...">). The
// legacy label stays in the registry for a few weeks in case LinkedIn is
// mid-rollout — neither matches a filter pill, so listing both is safe.
const APPLY_LINK_ARIA_LABELS = [
  'LinkedIn Apply to this job',
  'Easy Apply to this job',
];

function buildApplyLinkSelector() {
  return APPLY_LINK_ARIA_LABELS
    .map(label => `a[aria-label="${label}"]`)
    .join(', ');
}

// ── Exact daily-limit messages (must remain exact known variants) ──
const LINKEDIN_DAILY_SUBMISSION_LIMIT_MESSAGES = [
  'We limit daily submissions to maintain quality and prevent bots, helping each application get the right attention. Save this job and apply tomorrow.',
  'Great effort applying today. We limit Easy Apply submissions to help ensure each application gets the right attention. Save this job and continue applying tomorrow. Learn more',
];

function normalizeVisibleText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function hasLinkedInDailySubmissionLimitMessage(text) {
  const normalized = normalizeVisibleText(text);
  if (!normalized) return false;
  return LINKEDIN_DAILY_SUBMISSION_LIMIT_MESSAGES.some(message =>
    normalized.includes(normalizeVisibleText(message))
  );
}

// ── Search-page diagnostic helpers ──
//
// Why these exist: the cron's daily LinkedIn loop started logging
// `cardCount: 0` from 2026-04-26 onward despite identical code that was
// applying 25–35 jobs/day the week prior. With only `cardCount: 0` to go on
// it's impossible to tell whether the DOM moved, the session got bounced to
// a login wall, a bot challenge fired, or LinkedIn's daily cap is suppressing
// results. analyzeSearchPageState classifies the page from a structured
// snapshot so the next run captures *why*, and pickCardStrategy chooses
// among fallback selectors when the primary one comes up empty.

function pickCardStrategy(counts) {
  const c = counts || {};
  if ((c.easyApplyCardCount || 0) > 0) return 'easy_apply_button';
  if ((c.jobIdAttrCount || 0) > 0) return 'data_job_id';
  if ((c.jobLinkCount || 0) > 0) return 'job_link';
  return null;
}

/**
 * Decide whether a role=button's accessible text looks like a job card.
 *
 * The 2026-04-30 search-results redesign dropped "Easy Apply" from card
 * badges (now just " Apply") and randomized container class names — so the
 * legacy `getByRole('button').filter({hasText: 'Easy Apply'})` selector
 * matches nothing. Cards still render as role=button divs, but so do filter
 * pills ("LinkedIn Apply"), nav buttons ("Jobs"), and tooltip triggers.
 * This classifier separates the two using stable card-text markers
 * captured from a real production diagnostic.
 */
function isJobCardText(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 30) return false;
  if (!/\bApply\b/i.test(trimmed)) return false;
  return /\(Verified job\)|Be an early applicant|\bago\b|Promoted by hirer/i.test(trimmed);
}

function analyzeSearchPageState(state) {
  const s = state || {};
  const url = String(s.url || '');
  const bodyText = String(s.bodyText || '');
  const easyApplyCardCount = s.easyApplyCardCount || 0;
  const jobIdAttrCount = s.jobIdAttrCount || 0;
  const jobLinkCount = s.jobLinkCount || 0;
  const totalButtons = s.totalButtons || 0;

  if (easyApplyCardCount > 0) {
    return { kind: 'ok', message: `Found ${easyApplyCardCount} Easy Apply cards.` };
  }

  if (/\/login(?:\?|$|\/)/i.test(url) || /\/authwall/i.test(url)) {
    return { kind: 'login_required', message: `Login wall detected — URL redirected to ${url}.` };
  }

  if (/\/checkpoint\/challenge/i.test(url) ||
      /security check|security verification|verify you'?re human|prove you'?re not a robot/i.test(bodyText)) {
    return { kind: 'bot_challenge', message: 'Bot or security challenge page detected.' };
  }

  if (hasLinkedInDailySubmissionLimitMessage(bodyText) || /reached today.?s easy apply limit/i.test(bodyText)) {
    return { kind: 'rate_limited', message: 'LinkedIn daily Easy Apply limit reached.' };
  }

  if (/no matching jobs|no jobs matching|0 results|no results found/i.test(bodyText)) {
    return { kind: 'no_results', message: 'Search returned no matching jobs.' };
  }

  if (/(sign in|join now)/i.test(bodyText) && jobIdAttrCount === 0 && jobLinkCount === 0) {
    return { kind: 'login_required', message: 'Page shows sign-in copy with no job content — likely an authwall.' };
  }

  if (jobIdAttrCount > 0 || jobLinkCount > 0) {
    return {
      kind: 'dom_changed',
      message: `Job entities present (jobIdAttrCount=${jobIdAttrCount}, jobLinkCount=${jobLinkCount}) but Easy Apply selector found 0 — DOM likely changed.`,
    };
  }

  return { kind: 'unknown', message: `No cards and no known signal matched (totalButtons=${totalButtons}).` };
}

// ── Job filter (pure, no network) ──

// Remote-flavored location strings ("United States (Remote)", "Remote - US",
// "Anywhere in the United States") never contain an allowlisted state, so
// they must match semantically, not by state alias (spec R2).
function isRemoteLocation(location) {
  const text = String(location || '');
  return /\bremote\b/i.test(text) || /\banywhere in the (united states|u\.?s\.?a?)\b/i.test(text);
}

function matchesAllowedLocation(location, configuredLocation) {
  const text = String(location || '').trim();
  if (!text) return true; // Missing card location should not become a false negative.

  const candidate = String(configuredLocation || '').trim().toLowerCase();
  if (!candidate) return true;

  const lower = text.toLowerCase();
  const aliasPatterns = {
    california: [/\bcalifornia\b/i, /,\s*ca\b/i, /\bca\s*\(/i],
    newyork: [/\bnew york\b/i, /,\s*ny\b/i, /\bny\s*\(/i],
    massachusetts: [/\bmassachusetts\b/i, /,\s*ma\b/i, /\bma\s*\(/i],
  };

  const normalized = candidate.replace(/[\s,]+/g, '');
  const patterns = aliasPatterns[normalized];
  if (patterns) return patterns.some(re => re.test(lower));

  return lower.includes(candidate);
}

const DEFAULT_AGENCY_COMPANY_KEYWORDS = [
  'recruiting',
  'recruitment',
  'staffing',
  'executive search',
  'search group',
  'search firm',
  'talent acquisition',
  'talent solutions',
  'staffing solution',
  'workforce solutions',
  'employment agency',
  'placement agency',
  'consulting services',
  'technology consulting',
  'it consulting',
];

const DEFAULT_AGENCY_COMPANY_PATTERNS = [
  '\\bjobright\\.ai\\b',
  '\\bharnham\\b',
  '\\bproven recruiting\\b',
  '\\bgreen key resources\\b',
  '\\bbeaconfire\\b',
  '\\binsight global\\b',
  '\\bkforce\\b',
  '\\brobert half\\b',
  '\\bgoliath partners\\b',
  '\\bacceler8 talent\\b',
  '\\bsynergisticit\\b',
  '\\bledgent technology\\b',
  '\\bcompunnel\\b',
  '\\bnet2source\\b',
  '\\bakkodis\\b',
  '\\bcybercoders\\b',
  '\\bjobot\\b',
  '\\baquent\\b',
  '\\bbayone solutions\\b',
  '\\bdewinter group\\b',
  '\\bhireclout\\b',
  '\\bworkgenius group\\b',
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesCompanyKeyword(companyLower, keyword) {
  const normalized = String(keyword || '').trim().toLowerCase();
  if (!normalized) return false;
  const escaped = escapeRegExp(normalized).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(companyLower);
}

function matchesCompanyPattern(company, pattern) {
  if (!pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(company);
  } catch (_) {
    return false;
  }
}

function matchAgencyCompanySignal(company, filter) {
  if (!company) return null;

  const companyLower = company.toLowerCase();
  const configuredKeywords = Array.isArray(filter.blockCompanyKeywords) ? filter.blockCompanyKeywords : [];
  const defaultKeywords = filter.blockLikelyRecruitingAgencies === false ? [] : DEFAULT_AGENCY_COMPANY_KEYWORDS;
  const keywords = [...defaultKeywords, ...configuredKeywords];
  for (const keyword of keywords) {
    if (matchesCompanyKeyword(companyLower, keyword)) {
      return { reason: `blocked_company_keyword:${keyword}` };
    }
  }

  const configuredPatterns = Array.isArray(filter.blockCompanyPatterns) ? filter.blockCompanyPatterns : [];
  const defaultPatterns = filter.blockLikelyRecruitingAgencies === false ? [] : DEFAULT_AGENCY_COMPANY_PATTERNS;
  const patterns = [...defaultPatterns, ...configuredPatterns];
  for (const pattern of patterns) {
    if (matchesCompanyPattern(company, pattern)) {
      return { reason: `blocked_company_pattern:${pattern}` };
    }
  }

  return null;
}

function shouldApply(title, company, locationOrConfig, maybeConfig) {
  const location = maybeConfig ? locationOrConfig : null;
  const config = maybeConfig || locationOrConfig || {};
  const filter = config.search?.jobFilter;

  const locationFilter = config.search?.locationFilter;
  if (Array.isArray(locationFilter) && locationFilter.length > 0) {
    const includeRemote = config.search?.includeRemote === true || config.search?.remoteOnly === true;
    const remote = isRemoteLocation(location);
    const matchedLocation = locationFilter.some(target => matchesAllowedLocation(location, target));
    if (!matchedLocation && !(remote && includeRemote)) {
      const reason = remote ? 'location_no_match_remote_disabled' : 'location_no_match_region';
      return { apply: false, skipReason: `${reason}:${location || 'unknown'}` };
    }
  }

  if (!filter) return { apply: true };

  const titleLower = (title || '').toLowerCase();
  const companyLower = (company || '').toLowerCase();

  if (filter.blockCompanies) {
    for (const blocked of filter.blockCompanies) {
      if (companyLower.includes(blocked.toLowerCase())) {
        return { apply: false, skipReason: `blocked_company:${blocked}` };
      }
    }
  }

  const agencySignal = matchAgencyCompanySignal(company || '', filter);
  if (agencySignal) {
    return { apply: false, skipReason: agencySignal.reason };
  }

  if (filter.blockTitleKeywords) {
    for (const kw of filter.blockTitleKeywords) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(title || '')) {
        return { apply: false, skipReason: `blocked_title:${kw}` };
      }
    }
  }

  if (filter.requireTitleKeywords && filter.requireTitleKeywords.length > 0) {
    const matched = filter.requireTitleKeywords.some(kw => {
      if (kw.includes(' ')) return titleLower.includes(kw.toLowerCase());
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return re.test(title || '');
    });
    if (!matched) {
      return { apply: false, skipReason: `title_no_match:${title}` };
    }
  }

  return { apply: true };
}

// ── Screenshot helper ──

async function screenshotError(page, platform, jobId, config) {
  if (!config.behavior?.screenshotOnError) return;
  try {
    const dir = path.join(process.cwd(), 'logs', 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const fname = `${today}-${platform}-${(jobId || 'unknown').replace(/[^a-z0-9]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(dir, fname), fullPage: false });
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════
//  Frame + Search URL
// ══════════════════════════════════════════════════════════

/**
 * Get the SDUI apply form's shadow root as an ElementHandle.
 * The apply form lives inside #interop-outlet → shadowRoot.
 * Returns null if not found (form may not be open yet).
 */
async function getApplyShadowRoot(page) {
  return page.evaluateHandle(() => {
    const interop = document.querySelector('#interop-outlet');
    return interop?.shadowRoot || null;
  }).catch(() => null);
}

/**
 * Execute fillForm against the SDUI shadow DOM.
 * Since fillForm expects a Page-like context with $() and $$(),
 * and shadow roots don't have those methods, we use page.evaluate()
 * to fill fields directly inside the shadow root via defaultAnswers.
 */
const EMPTY_SHADOW_RESULT = () => ({
  filled: 0, unfilled: [], blocked: [], guardedPending: [], fills: [],
  topChoice: { present: false, checked: false },
});

async function fillShadowForm(page, defaultAnswers, logger, jobId, opts = {}) {
  const config = opts.config || {};
  const runId = opts.runId || null;
  const flatAnswers = defaultAnswers.defaultAnswers || defaultAnswers;
  // Spec R14: never consume platform boosts/credits unless explicitly allowed.
  const topChoicePolicy = config.platformPolicy?.linkedin?.topChoice || 'never';

  const result = await page.evaluate(({ answerMap, guardedSources, validatorPatterns, topChoicePolicy }) => {
    const interop = document.querySelector('#interop-outlet');
    if (!interop || !interop.shadowRoot) {
      return { filled: 0, unfilled: [], blocked: [], guardedPending: [], fills: [], topChoice: { present: false, checked: false } };
    }
    const sr = interop.shadowRoot;

    let filled = 0;
    const unfilled = [];
    const blocked = [];
    const guardedPending = [];
    const fills = [];
    const topChoice = { present: false, checked: false };

    // Keep in sync with lib/answer-policy.js normalize() — evaluate() cannot import it.
    function normalizeQ(s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9+/\s]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    const guardedRes = guardedSources.map((src) => new RegExp(src));
    function isGuarded(label) {
      const n = normalizeQ(label);
      return !!n && guardedRes.some((re) => re.test(n));
    }
    const rejectRes = validatorPatterns.map(([src, flags]) => new RegExp(src, flags));
    function isRejectedValue(v) {
      return rejectRes.some((re) => re.test(String(v)));
    }

    // Tag elements so the Node-side guarded pass can find them again.
    let fieldSeq = 0;
    function tagField(el) {
      const tag = `agent-f${fieldSeq++}`;
      el.setAttribute('data-agent-field', tag);
      return tag;
    }

    // Helper: find label text for a form element
    function getLabelText(el) {
      const id = el.id;
      if (id) {
        const label = sr.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent.trim();
      }
      const parent = el.closest('div, fieldset, li');
      if (parent) {
        const label = parent.querySelector('label, legend');
        if (label) return label.textContent.trim();
      }
      return '';
    }

    // Group label: fieldset legend FIRST. Each radio option sits in its own
    // <div>, so closest('fieldset, div, li') used to return the option
    // wrapper and the question degraded to the option text ("Yes") — 418
    // unfilled_fields rows with label "Yes" over 3 months.
    function getGroupLabel(radio) {
      const fieldset = radio.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend && legend.textContent.trim()) return legend.textContent.trim();
      }
      let p = radio.parentElement;
      for (let i = 0; i < 6 && p && p !== sr; i++, p = p.parentElement) {
        const legend = p.querySelector('legend');
        if (legend && legend.textContent.trim()) return legend.textContent.trim();
      }
      // Last resort: a nearby label that is NOT an option label (option labels
      // carry for= pointing at a radio input).
      const parent = radio.closest('div, li');
      const label = parent && parent.querySelector('label');
      if (label && !label.htmlFor && label.textContent.trim()) return label.textContent.trim();
      return '';
    }

    // Helper: fuzzy match a label against defaultAnswers
    function fuzzyMatch(labelText) {
      const labelLower = labelText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      if (!labelLower) return null;
      let bestMatch = null;
      let bestScore = 0;
      for (const [key, val] of Object.entries(answerMap)) {
        const keyLower = key.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (labelLower.includes(keyLower) || keyLower.includes(labelLower)) {
          const score = Math.min(labelLower.length, keyLower.length);
          if (score > bestScore) { bestScore = score; bestMatch = val; }
        }
      }
      return bestMatch;
    }

    // ── Handle standard inputs (text, select, textarea) ──
    for (const el of sr.querySelectorAll('input, select, textarea')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (el.type === 'hidden') continue;

      // Skip radio/checkbox — handled separately below
      if (el.type === 'radio' || el.type === 'checkbox') continue;

      const labelText = getLabelText(el);

      // Skip if already has a value
      if (el.value && el.value.trim()) { filled++; continue; }

      const fieldType = el.tagName === 'SELECT' ? 'select'
        : el.tagName === 'TEXTAREA' ? 'textarea'
        : (el.type || 'text');

      // Never-auto-answer guard (spec R8): guarded questions skip fuzzy
      // matching entirely; the Node side answers from exact config or blocks.
      if (labelText && isGuarded(labelText)) {
        guardedPending.push({ label: labelText, type: fieldType, tag: tagField(el) });
        continue;
      }

      const match = fuzzyMatch(labelText);
      if (match) {
        if (isRejectedValue(match)) {
          blocked.push({ label: labelText, type: fieldType, reason: 'output_guard', answer: String(match).substring(0, 60) });
          continue;
        }
        if (el.tagName === 'SELECT') {
          for (const opt of el.options) {
            if (opt.text.toLowerCase().includes(match.toLowerCase()) ||
                match.toLowerCase().includes(opt.text.toLowerCase())) {
              el.value = opt.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              filled++;
              fills.push({ label: labelText, type: fieldType, answer: opt.text, source: 'shadow_fuzzy', matchType: 'exact_key' });
              break;
            }
          }
        } else {
          el.value = match;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
          fills.push({ label: labelText, type: fieldType, answer: String(match).substring(0, 200), source: 'shadow_fuzzy', matchType: 'exact_key' });
        }
      } else if (labelText) {
        unfilled.push({ label: labelText, type: fieldType });
      }
    }

    // ── Handle radio button groups ──
    // Group radios by name, find the group label, match against defaultAnswers
    const radioGroups = new Map();
    for (const radio of sr.querySelectorAll('input[type="radio"]')) {
      const name = radio.name || radio.getAttribute('name') || '';
      if (!name) continue;
      if (!radioGroups.has(name)) radioGroups.set(name, []);
      radioGroups.get(name).push(radio);
    }
    for (const [name, radios] of radioGroups) {
      // Skip if already selected
      if (radios.some(r => r.checked)) { filled++; continue; }

      const groupLabel = getGroupLabel(radios[0]);

      if (groupLabel && isGuarded(groupLabel)) {
        const container = radios[0].closest('fieldset') || radios[0].parentElement;
        guardedPending.push({ label: groupLabel, type: 'radio', tag: tagField(container) });
        continue;
      }

      const match = fuzzyMatch(groupLabel);
      if (match && !isRejectedValue(match)) {
        // Click the radio whose label matches the answer
        const matchLower = match.toLowerCase();
        let clicked = false;
        for (const radio of radios) {
          const radioLabel = getLabelText(radio) || radio.value || '';
          if (radioLabel.toLowerCase().includes(matchLower) ||
              matchLower.includes(radioLabel.toLowerCase())) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            // Also click the label if it exists
            const id = radio.id;
            if (id) {
              const label = sr.querySelector(`label[for="${id}"]`);
              if (label) label.click();
            }
            filled++;
            clicked = true;
            fills.push({ label: groupLabel, type: 'radio', answer: radioLabel, source: 'shadow_fuzzy', matchType: 'exact_key' });
            break;
          }
        }
        // Spec R10: no Yes-default. An unmatched option set stays unfilled
        // rather than guessing — wrong-polarity Yes answers were submitted
        // to military/sanctions/non-compete questions under the old default.
        if (!clicked) unfilled.push({ label: groupLabel, type: 'radio' });
      } else if (groupLabel) {
        unfilled.push({ label: groupLabel, type: 'radio' });
      }
    }

    // ── Handle standalone checkboxes ──
    for (const cb of sr.querySelectorAll('input[type="checkbox"]')) {
      const labelText = getLabelText(cb) || '';
      const labelLower = labelText.toLowerCase();
      const isTopChoice = labelLower.includes('top choice') ||
        (labelLower.includes('mark') && labelLower.includes('job'));

      if (isTopChoice) {
        // LinkedIn's boost checkbox. Policy-driven (spec R14): default is
        // 'never' — do not consume Top Choice credits. 'always' opts in.
        topChoice.present = true;
        if (topChoicePolicy === 'always' && !cb.checked) {
          cb.click();
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
          fills.push({ label: labelText, type: 'checkbox', answer: 'checked', source: 'platform_policy:top_choice', matchType: 'policy_always' });
        }
        topChoice.checked = cb.checked;
        continue;
      }

      if (cb.checked) continue;
      if (labelLower.includes('agree') || labelLower.includes('certify') ||
          labelLower.includes('confirm') || labelLower.includes('acknowledge')) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
        fills.push({ label: labelText, type: 'checkbox', answer: 'checked', source: 'rule:consent_checkbox', matchType: 'consent' });
      }
    }

    return { filled, unfilled, blocked, guardedPending, fills, topChoice };
  }, {
    answerMap: flatAnswers,
    guardedSources: GUARDED_PATTERN_SOURCES,
    validatorPatterns: VALIDATOR_PATTERN_SOURCES,
    topChoicePolicy,
  }).catch(() => EMPTY_SHADOW_RESULT());

  // ── Guarded pass: exact config answers or explicit blocks (spec R8) ──
  for (const pending of result.guardedPending || []) {
    const decision = guardAnswer(pending.label, { config, defaultAnswers: flatAnswers });
    if (decision.action === 'answer') {
      const v = validateAnswer(decision.answer, { label: pending.label, fieldType: pending.type });
      if (v.ok) {
        const applied = await applyGuardedShadowFill(page, pending, v.answer).catch(() => false);
        if (applied) {
          result.filled++;
          result.fills.push({ label: pending.label, type: pending.type, answer: v.answer, source: decision.source, matchType: 'guard_config' });
          continue;
        }
      }
    }
    result.blocked.push({ label: pending.label, type: pending.type, reason: decision.reason || 'guard_apply_failed', questionClass: decision.questionClass });
  }

  // ── Audit every decision (fill_audit had no shadow-path rows before) ──
  const audit = (fieldLabel, fieldType, fillSource, answer, confidence) => {
    try {
      recordFillAudit({ platform: 'linkedin', jobId, runId, fieldLabel, fieldType, inputType: null, fillSource, answer, confidence });
    } catch (_) {}
  };
  for (const f of result.fills || []) audit(f.label, f.type, f.source, f.answer, f.matchType);
  for (const b of result.blocked || []) audit(b.label, b.type, 'cannot_fill', '', b.reason);
  if (result.topChoice && result.topChoice.present) {
    audit('Mark job as a top choice', 'checkbox', 'platform_policy',
      result.topChoice.checked ? 'checked' : 'left_unchecked', `top_choice:${topChoicePolicy}`);
  }

  if (result.filled > 0) {
    logger.debug({ platform: 'linkedin', jobId, filled: result.filled }, 'Filled shadow DOM form fields');
  }
  if ((result.blocked || []).length > 0) {
    logger.info({ platform: 'linkedin', jobId, blocked: result.blocked }, 'Guard blocked shadow form fields');
    for (const field of result.blocked) {
      recordUnfilledField({ platform: 'linkedin', jobId, fieldLabel: field.label, fieldType: field.type });
    }
  }
  if (result.unfilled.length > 0) {
    logger.debug({ platform: 'linkedin', jobId, unfilled: result.unfilled }, 'Unfilled shadow DOM form fields');
    for (const field of result.unfilled) {
      recordUnfilledField({ platform: 'linkedin', jobId, fieldLabel: field.label, fieldType: field.type });
    }
  }

  return result;
}

/**
 * Apply a guard-approved answer to a shadow-form field tagged during
 * collection (data-agent-field). Radios/selects match the option whose
 * label equals or contains the configured answer; text inputs set the value.
 *
 * @returns {Promise<boolean>} true when a fill was applied
 */
async function applyGuardedShadowFill(page, pending, answer) {
  return page.evaluate(({ tag, type, answer }) => {
    const interop = document.querySelector('#interop-outlet');
    const sr = interop?.shadowRoot;
    if (!sr) return false;
    const el = sr.querySelector(`[data-agent-field="${tag}"]`);
    if (!el) return false;

    const answerLower = String(answer).toLowerCase();
    const optionMatches = (text) => {
      const t = String(text || '').trim().toLowerCase();
      if (!t) return false;
      return t === answerLower || t.includes(answerLower) || (t.length >= 3 && answerLower.includes(t));
    };

    if (type === 'radio') {
      for (const radio of el.querySelectorAll('input[type="radio"]')) {
        const label = radio.id ? sr.querySelector(`label[for="${radio.id}"]`) : null;
        const optText = (label && label.textContent.trim()) || radio.value || '';
        if (optionMatches(optText)) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          if (label) label.click();
          return true;
        }
      }
      return false;
    }

    if (el.tagName === 'SELECT') {
      for (const opt of el.options) {
        if (opt.value !== '' && optionMatches(opt.text)) {
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }

    el.value = String(answer);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { tag: pending.tag, type: pending.type, answer });
}

/**
 * Build a /jobs/search-results/ URL from config.
 * LinkedIn-specific params (geoId, f_SAL) come from platforms.linkedin in config.
 */
function buildLinkedInSearchUrl(config) {
  const keywords = (config.search?.keywords || ['data scientist']).join(' ');
  const li = config.platforms?.linkedin || {};

  const params = new URLSearchParams();
  params.set('keywords', keywords);
  if (li.geoId) params.set('geoId', li.geoId);
  if (li.distance != null) params.set('distance', String(li.distance));
  params.set('f_TPR', li.f_TPR || 'r86400');
  params.set('f_AL', 'true');
  if (li.f_SAL) params.set('f_SAL', li.f_SAL);

  return `https://www.linkedin.com/jobs/search-results/?${params.toString()}`;
}

// ══════════════════════════════════════════════════════════
//  Result Card Helpers
// ══════════════════════════════════════════════════════════

/**
 * Find all result card locators on the current page.
 *
 * Multi-strategy: from 2026-04-26 onward the cron started logging cardCount=0
 * even though the same code worked the day before (last commit to this file
 * was 2026-04-14). Whatever LinkedIn changed, the legacy role=button +
 * "Easy Apply" filter no longer reliably matches. Fall back through stable
 * data-attribute selectors so the agent keeps applying instead of silently
 * exiting after 22 seconds.
 */
async function listResultCards(page) {
  try {
    await Promise.race([
      page.getByRole('button').filter({ hasText: 'Easy Apply' }).first().waitFor({ timeout: SELECTOR_TIMEOUT }),
      page.locator('li[data-occludable-job-id]').first().waitFor({ timeout: SELECTOR_TIMEOUT }),
      page.locator('[data-job-id]').first().waitFor({ timeout: SELECTOR_TIMEOUT }),
      page.getByRole('button')
        .filter({ hasText: /\(Verified job\)|Be an early applicant|Promoted by hirer/i })
        .first().waitFor({ timeout: SELECTOR_TIMEOUT }),
    ]);
  } catch (_) {}

  const primary = await page.getByRole('button').filter({ hasText: 'Easy Apply' }).all();
  if (primary.length > 0) return primary;

  const liCards = await page.locator('li[data-occludable-job-id]').all();
  if (liCards.length > 0) return liCards;

  const dataIdCards = await page.locator('[data-job-id]').all();
  if (dataIdCards.length > 0) return dataIdCards;

  // 2026-04-26+ DOM: cards are role=button divs with hashed class names and
  // " Apply" (no longer "Easy Apply") in their accessible text. Discriminate
  // them from filter pills / nav buttons by checking for stable card markers.
  // Single page.evaluateAll() round-trip — chatty per-button innerText() loops
  // appeared to compound the new SPA's renderer pressure during testing.
  const cardIndices = await page.getByRole('button').evaluateAll((els) => {
    return els
      .map((el, i) => {
        const text = (el.textContent || '').trim();
        if (text.length < 30) return -1;
        if (!/\bApply\b/i.test(text)) return -1;
        if (!/\(Verified job\)|Be an early applicant|\bago\b|Promoted by hirer/i.test(text)) return -1;
        return i;
      })
      .filter(i => i >= 0);
  }).catch(() => []);

  if (cardIndices.length === 0) return [];
  const baseLocator = page.getByRole('button');
  return cardIndices.map(i => baseLocator.nth(i));
}

async function countResultCards(page) {
  // Lightweight pagination check — does NOT need an exact count. Used by
  // goToNextPage only to confirm "the next page rendered something". Avoid
  // calling listResultCards here so we don't run the full multi-strategy
  // iteration just to verify page navigation worked.
  const easy = await page.getByRole('button').filter({ hasText: 'Easy Apply' }).count().catch(() => 0);
  if (easy > 0) return easy;
  const li = await page.locator('li[data-occludable-job-id]').count().catch(() => 0);
  if (li > 0) return li;
  return page.getByRole('button').filter({ hasText: 'Apply' }).count().catch(() => 0);
}

/**
 * Snapshot the search page so analyzeSearchPageState can classify why no
 * cards were found. Runs entirely in the page context; returns null on
 * failure rather than throwing, since this path is itself a diagnostic for
 * a failure case and must not introduce a second one.
 */
async function captureSearchPageState(page) {
  return page.evaluate(() => {
    const easyApplyCardCount = Array.from(document.querySelectorAll('[role="button"], button'))
      .filter(el => (el.textContent || '').includes('Easy Apply')).length;
    const liCardCount = document.querySelectorAll('li[data-occludable-job-id]').length;
    const jobIdAttrCount = document.querySelectorAll('[data-job-id], [data-occludable-job-id]').length;
    const jobLinkCount = document.querySelectorAll('a[href*="/jobs/view/"]').length;
    const totalButtons = document.querySelectorAll('button, [role="button"]').length;
    const bodyText = document.body && document.body.innerText
      ? document.body.innerText.slice(0, 8000)
      : '';

    // ── Extra signals collected while we figure out the new card markup ──
    const verifiedJobAncestors = [];
    const verifiedNodes = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0 && /\(Verified job\)/.test(el.textContent || ''));
    for (const node of verifiedNodes.slice(0, 3)) {
      let cur = node;
      const chain = [];
      for (let depth = 0; depth < 10 && cur; depth++) {
        const tag = (cur.tagName || '').toLowerCase();
        const id = cur.id ? `#${cur.id}` : '';
        const cls = cur.className && typeof cur.className === 'string'
          ? `.${cur.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
        const role = cur.getAttribute && cur.getAttribute('role') ? `[role=${cur.getAttribute('role')}]` : '';
        const dataJobId = cur.getAttribute && cur.getAttribute('data-job-id') ? '[data-job-id]' : '';
        const dataOccl = cur.getAttribute && cur.getAttribute('data-occludable-job-id') ? '[data-occludable-job-id]' : '';
        chain.push(`${tag}${id}${cls}${role}${dataJobId}${dataOccl}`);
        cur = cur.parentElement;
      }
      verifiedJobAncestors.push(chain);
    }

    const cardClassCandidates = {};
    for (const sel of [
      'li.scaffold-layout__list-item',
      '[class*="job-card-job-posting-card-wrapper"]',
      '[class*="job-card-container"]',
      '[class*="job-card-list"]',
      '[class*="jobs-search-results__list-item"]',
      'div[data-view-name="job-card"]',
      'a[data-control-name*="job_card"]',
      '[role="article"]',
      '[role="link"][href*="/jobs/view/"]',
    ]) {
      try { cardClassCandidates[sel] = document.querySelectorAll(sel).length; }
      catch (_) { cardClassCandidates[sel] = -1; }
    }

    return {
      url: window.location.href,
      title: document.title,
      bodyText,
      easyApplyCardCount,
      liCardCount,
      jobIdAttrCount,
      jobLinkCount,
      totalButtons,
      cardClassCandidates,
      verifiedJobAncestors,
    };
  }).catch(() => null);
}

async function screenshotDebug(page, label) {
  try {
    const dir = path.join(process.cwd(), 'logs', 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const fname = `${today}-linkedin-${label}.png`;
    await page.screenshot({ path: path.join(dir, fname), fullPage: false });
    return path.join(dir, fname);
  } catch (_) {
    return null;
  }
}

/**
 * Parse a result card's accessible text into structured fields.
 * Card buttons contain paragraphs: title, company, location, metadata.
 *
 * Returns null if the card text cannot be parsed (unloaded/empty).
 */
function summarizeResultCard(rawText) {
  if (!rawText || rawText.length < 20) return null;

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // Two card formats:
  //   Non-verified: Title → Company → Location → ...
  //   Verified:     "Title (Verified job)" → Title (repeated) → Company → Location → ...
  // The "(Verified job)" suffix on line 1 is the signal.

  let title = null;
  let company = null;
  let location = null;

  const meaningful = lines.filter(l => l.length >= 3 && !l.startsWith('Dismiss'));
  if (meaningful.length === 0) return null;

  const firstLine = meaningful[0];
  const isVerified = /\(Verified job\)/i.test(firstLine);
  title = firstLine.replace(/\s*\(Verified job\)\s*/i, '').trim();

  if (isVerified) {
    // Verified: line 0 = "Title (Verified job)", line 1 = Title (skip), line 2 = Company, line 3 = Location
    // Skip line 1 if it matches the cleaned title
    let idx = 1;
    if (meaningful[idx] && meaningful[idx].toLowerCase() === title.toLowerCase()) idx++;
    if (meaningful[idx]) company = meaningful[idx];
    // Look for location in remaining lines
    for (let j = idx + 1; j < meaningful.length; j++) {
      if (/[A-Z]{2}\s*\(/.test(meaningful[j]) || /remote/i.test(meaningful[j])) {
        location = meaningful[j];
        break;
      }
    }
  } else {
    // Non-verified: line 0 = Title, line 1 = Company, line 2+ = Location
    if (meaningful[1]) company = meaningful[1];
    for (let j = 2; j < meaningful.length; j++) {
      if (/[A-Z]{2}\s*\(/.test(meaningful[j]) || /remote/i.test(meaningful[j])) {
        location = meaningful[j];
        break;
      }
    }
  }

  const hasEasyApplyBadge = rawText.includes('Easy Apply');
  const hasAppliedBadge = /\bApplied\b/.test(rawText);

  return { title, company, location, hasEasyApplyBadge, hasAppliedBadge, rawText };
}

/**
 * Click a result card to load its detail in the right panel.
 */
async function selectCard(cardLocator) {
  await cardLocator.scrollIntoViewIfNeeded();
  await sleep(200, 400);
  // force: true bypasses the interop-outlet shadow DOM overlay that intercepts pointer events
  await cardLocator.click({ force: true });
  await sleep(1500, 3000);
}

// ══════════════════════════════════════════════════════════
//  Selected Job Detail Helpers
// ══════════════════════════════════════════════════════════

/**
 * After clicking a card, extract detail from the loaded job view.
 * Job ID comes from the page URL's currentJobId param or /jobs/view/{id} links.
 * Operates on the top-level page (detail panel is not inside the iframe).
 */
async function extractSelectedJobDetail(page) {
  const detail = await page.evaluate(() => {
    const body = document.body;
    if (!body) return null;

    // Job ID from URL
    let jobId = null;
    try {
      jobId = new URL(window.location.href).searchParams.get('currentJobId');
    } catch (_) {}

    // Fallback: find /jobs/view/{id} link
    if (!jobId) {
      for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
        const m = a.href.match(/\/jobs\/view\/(\d+)/);
        if (m) { jobId = m[1]; break; }
      }
    }

    // Apply link — try both the new "LinkedIn Apply to this job" aria-label
    // (2026-04-26+) and the legacy "Easy Apply to this job" for safety.
    const easyApplyLink = document.querySelector(
      'a[aria-label="LinkedIn Apply to this job"], a[aria-label="Easy Apply to this job"]'
    );
    const easyApplyHref = easyApplyLink ? easyApplyLink.href : null;

    // Extract job ID from Easy Apply href as fallback
    if (!jobId && easyApplyHref) {
      const m = easyApplyHref.match(/\/jobs\/view\/(\d+)/);
      if (m) jobId = m[1];
    }

    // Promoted detection (detail-derived)
    const bodyText = body.innerText || '';
    const isPromoted = bodyText.includes('Promoted by hirer');

    // Already applied detection
    const alreadyApplied = bodyText.includes('Application submitted') ||
      /\bApplied\b/.test(bodyText.substring(0, 500));

    // Title and company from detail panel
    // The detail shows: company logo/link, then job title as a link, then location
    let title = null;
    let company = null;
    const mainEl = document.querySelector('main');
    if (mainEl) {
      // Title is typically the first link inside main that points to /jobs/view/
      const titleLink = mainEl.querySelector('a[href*="/jobs/view/"] p, main p a[href*="/jobs/view/"]');
      if (titleLink) title = titleLink.textContent.trim();

      // Company name: look for company link
      const companyLink = mainEl.querySelector('a[href*="/company/"] p');
      if (companyLink) company = companyLink.textContent.trim();
    }

    // Job description text from the detail panel
    let description = '';
    if (mainEl) {
      // The description is typically in an <article> inside main
      const articleEl = mainEl.querySelector('article');
      if (articleEl) description = (articleEl.innerText || '').trim().substring(0, 2000);
    }

    const jobUrl = jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : null;

    return { jobId, jobUrl, title, company, isPromoted, alreadyApplied, easyApplyHref, description };
  }).catch(() => null);

  // Also try getting jobId from the top-level page URL (more reliable)
  if (detail && !detail.jobId) {
    try {
      const pageUrl = new URL(page.url());
      detail.jobId = pageUrl.searchParams.get('currentJobId');
      if (detail.jobId) detail.jobUrl = `https://www.linkedin.com/jobs/view/${detail.jobId}`;
    } catch (_) {}
  }

  return detail;
}

/**
 * Click the Easy Apply link/button to enter the apply flow.
 * The link is on the top-level page (detail panel).
 * After clicking, the SDUI form loads (possibly in the /preload/ frame).
 * Returns 'entered', 'already_applied', or 'no_easy_apply'.
 */
async function enterEasyApply(page, logger) {
  // Try the Apply link. Post-2026-04-26 the aria-label is "LinkedIn Apply
  // to this job"; pre-2026-04-26 it was "Easy Apply to this job".
  // Use .first() — LinkedIn can render duplicate links for the same job.
  const easyApplyLink = page.locator(buildApplyLinkSelector()).first();
  if (await easyApplyLink.count() > 0) {
    await easyApplyLink.click({ force: true });
    await sleep(2000, 3000);
    return 'entered';
  }

  // Fallback: try button-based Easy Apply (old UI or A/B variant)
  const easyApplyBtn = page.locator('button:has-text("Easy Apply")').first();
  if (await easyApplyBtn.count() > 0) {
    const text = await easyApplyBtn.innerText().catch(() => '');
    if (text.toLowerCase().includes('applied')) return 'already_applied';
    await easyApplyBtn.click({ force: true });
    await sleep(2000, 3000);
    return 'entered';
  }

  return 'no_easy_apply';
}

async function collectApplyValidationErrors(page) {
  return page.evaluate(() => {
    const interop = document.querySelector('#interop-outlet');
    if (!interop || !interop.shadowRoot) return [];
    const sr = interop.shadowRoot;
    const errors = [];

    function add(text) {
      const normalized = String(text || '').replace(/\s+/g, ' ').trim();
      if (normalized && normalized.length > 3 && normalized.length < 220) {
        errors.push(normalized.substring(0, 160));
      }
    }

    for (const el of sr.querySelectorAll('[class*="error"], [role="alert"], [class*="invalid"]')) {
      add(el.textContent || '');
    }

    const asciiText = (sr.textContent || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const validationSignals = [
      'please enter a valid answer',
      'please make a selection',
      'enter a decimal number',
      'enter a number',
      'veuillez saisir une reponse valable',
      'effectuez une selection',
    ];
    for (const signal of validationSignals) {
      if (asciiText.includes(signal)) add(signal);
    }

    return [...new Set(errors)];
  }).catch(() => []);
}

// ══════════════════════════════════════════════════════════
//  Inline Apply Step Handler
// ══════════════════════════════════════════════════════════

/**
 * Handle one step of the SDUI apply flow.
 *
 * The form lives inside #interop-outlet → shadowRoot. Standard CSS queries
 * via page.$$() (which fillForm uses) cannot pierce shadow boundaries, so
 * the shadow-DOM filler runs first to handle inputs/radios/checkboxes
 * inside the shadow root. fillForm then sweeps anything on the top-level
 * page (resume upload, non-shadow controls). page.locator() pierces shadow
 * DOM for action-button clicks.
 *
 * Without the shadow pre-fill, every required field in the apply form is
 * invisible to the filler — the Next button stays disabled, the same
 * label fingerprint repeats, and `applyLinkedIn` throws
 * "Apply flow cycled — unfilled required fields" (regression observed
 * during the 2026-04-30 dry-run on kadence ML Researcher 4408212119).
 */
async function handleInlineApplyStep(page, defaultAnswers, config, logger, jobId, dryRun, stepNum, options = {}) {
  await sleep(800, 1500);

  // Per-step guard-refusal tracking: only the refusals on the step that
  // ultimately blocks matter for classifying an abandonment.
  if (options.guardBlockedLabels) options.guardBlockedLabels.clear();

  // ── Fill fields inside the apply form's shadow DOM ──
  const shadowFill = await fillShadowForm(page, defaultAnswers, logger, jobId, {
    config,
    runId: options.runId || null,
  }).catch(() => EMPTY_SHADOW_RESULT());
  if (shadowFill.filled > 0 || shadowFill.unfilled.length > 0 || (shadowFill.blocked || []).length > 0) {
    logger.debug({
      jobId, stepNum,
      shadowFilled: shadowFill.filled,
      shadowUnfilledCount: shadowFill.unfilled.length,
      shadowBlockedCount: (shadowFill.blocked || []).length,
    }, 'Shadow form pre-fill');
  }
  // Track guard refusals across steps so an eventual abandonment can be
  // attributed to the guard (honest skip) instead of counted as breakage.
  if (options.guardBlockedLabels) {
    for (const b of shadowFill.blocked || []) {
      if (b.label) options.guardBlockedLabels.add(b.label);
    }
  }

  // ── Top-level form (resume upload, non-shadow controls) ──
  try {
    await fillForm(page, defaultAnswers, config, logger, 'linkedin', jobId, options);
  } catch (_) {}

  await sleep(500, 1000);

  // ── Find and click the action button inside shadow DOM ──
  // Playwright's locator() pierces shadow DOM automatically.
  const buttonSpecs = [
    { locator: page.locator('button[aria-label="Submit application"]'), action: 'submit' },
    { locator: page.locator('#interop-outlet button:has-text("Submit application")'), action: 'submit' },
    { locator: page.locator('button[aria-label="Review your application"]'), action: 'next' },
    { locator: page.locator('button[aria-label="Continue to next step"]'), action: 'next' },
    { locator: page.locator('#interop-outlet button:has-text("Next")'), action: 'next' },
    { locator: page.locator('#interop-outlet button:has-text("Review")'), action: 'next' },
    { locator: page.locator('#interop-outlet button:has-text("Continue")'), action: 'next' },
  ];

  let btn = null;
  let btnAction = null;
  for (const { locator, action } of buttonSpecs) {
    if (await locator.count() > 0 && await locator.first().isVisible()) {
      btn = locator.first();
      btnAction = action;
      break;
    }
  }

  if (!btn) {
    logger.warn({ jobId, stepNum }, 'Could not find Next/Submit button in apply form');
    return 'error';
  }

  const btnText = await btn.innerText().catch(() => '?');
  logger.debug({ platform: 'linkedin', jobId, btnText: btnText.trim(), action: btnAction, stepNum }, 'Clicking apply button');

  if (btnAction === 'submit') {
    if (dryRun) {
      await screenshotError(page, 'linkedin', `dryrun-${jobId}`, config);
      logger.info({ jobId }, '[DRY RUN] Would submit — taking screenshot instead');
      // Dismiss the form
      const dismissBtn = page.locator('button[aria-label="Dismiss"]').first();
      try {
        if (await dismissBtn.count() > 0) {
          await dismissBtn.evaluate(e => e.click());
          await sleep(500, 1000);
          const discardBtn = page.locator('button:has-text("Discard")').first();
          if (await discardBtn.count() > 0) { await discardBtn.evaluate(e => e.click()); await sleep(500, 1000); }
        }
      } catch (_) {}
      return 'submitted';
    }
    await btn.evaluate(e => e.click());
    return 'submitted';
  }

  // action === 'next' — click via JS to bypass interop-outlet overlay
  await btn.evaluate(e => e.click());
  await sleep(1000, 1500);

  // Check for validation errors inside shadow DOM
  const postClickErrors = await collectApplyValidationErrors(page);

  if (postClickErrors.length > 0) {
    // ── Structured diagnostics for validation failures ──
    const fieldDiag = await page.evaluate(() => {
      const interop = document.querySelector('#interop-outlet');
      if (!interop || !interop.shadowRoot) return [];
      const sr = interop.shadowRoot;
      const fields = [];
      for (const el of sr.querySelectorAll('input, select, textarea')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (el.type === 'hidden') continue;
        const parent = el.closest('div, fieldset, li');
        const label = parent?.querySelector('label, legend');
        const labelText = label ? label.textContent.trim().substring(0, 80) : '';
        const hasError = parent?.querySelector('[class*="error"], [role="alert"]');
        fields.push({
          tag: el.tagName, type: el.type || '', label: labelText,
          hasValue: !!(el.value && el.value.trim()),
          valueLen: (el.value || '').length,
          hasError: !!hasError,
          inShadow: true,
        });
      }
      // Also check radio groups — fieldset first: closest('fieldset, div, li')
      // returns the option's own wrapper div and degrades the label to "Yes"
      for (const radio of sr.querySelectorAll('input[type="radio"]')) {
        const parent = radio.closest('fieldset') || radio.closest('div, li');
        const legend = parent?.querySelector('legend') || parent?.querySelector('label');
        const groupLabel = legend ? legend.textContent.trim().substring(0, 80) : '';
        if (groupLabel && !fields.some(f => f.label === groupLabel)) {
          fields.push({ tag: 'INPUT', type: 'radio', label: groupLabel, hasValue: radio.checked, valueLen: 0, hasError: false, inShadow: true });
        }
      }
      return fields;
    }).catch(() => []);

    logger.warn({
      platform: 'linkedin', jobId, stepNum,
      errors: postClickErrors,
      fields: fieldDiag,
      btnText: btnText.trim(),
    }, 'Validation failure — field diagnostics');

    const retry = await retryInvalidFields(page, defaultAnswers, config, logger, 'linkedin', jobId, options).catch(() => ({ retryFilled: 0 }));
    if (options.guardBlockedLabels) {
      for (const l of retry.guardedInvalid || []) options.guardBlockedLabels.add(l);
    }
    if (retry.retryFilled > 0) {
      await sleep(300, 600);
      await btn.evaluate(e => e.click());
      await sleep(1000, 1500);
      const stillErrors = await collectApplyValidationErrors(page);
      if (stillErrors.length > 0) {
        logger.warn({ platform: 'linkedin', jobId, stepNum, errors: stillErrors }, 'Validation still failing after retry');
        return 'retry_failed';
      }
      return 'next';
    }
    return 'retry_failed';
  }
  return 'next';
}

// ══════════════════════════════════════════════════════════
//  Pagination
// ══════════════════════════════════════════════════════════

async function goToNextPage(page, currentPage, logger) {
  const nextPageNum = currentPage + 1;

  // Try page number button (aria-label="Page N")
  const pageBtn = page.locator(`button[aria-label="Page ${nextPageNum}"]`);
  if (await pageBtn.count() > 0) {
    await pageBtn.click({ force: true });
    await sleep(2000, 3000);
    const cards = await countResultCards(page);
    if (cards > 0) {
      logger.info({ platform: 'linkedin', page: nextPageNum, cardCount: cards }, `Navigated to page ${nextPageNum}`);
      return true;
    }
  }

  // Fallback: "Next" button in pagination
  const nextBtn = page.locator('button:has-text("Next")').last();
  if (await nextBtn.count() > 0) {
    const text = await nextBtn.innerText().catch(() => '');
    if (text.trim() === 'Next' || text.trim().includes('Next')) {
      await nextBtn.click({ force: true });
      await sleep(2000, 3000);
      const cards = await countResultCards(page);
      if (cards > 0) {
        logger.info({ platform: 'linkedin', page: nextPageNum }, `Navigated to page ${nextPageNum} via Next`);
        return true;
      }
    }
  }

  logger.info({ platform: 'linkedin', page: currentPage }, `No more pages after page ${currentPage}`);
  return false;
}

// ══════════════════════════════════════════════════════════
//  Main Entry Point
// ══════════════════════════════════════════════════════════

async function applyLinkedIn(page, config, defaultAnswers, state, runId, logger, dryRun = false, llmCache = null, sessionId = 0) {
  const platformConfig = config.platforms.linkedin;
  const maxApplications = platformConfig.maxApplicationsPerRun;
  const { minDelayBetweenApplications, maxDelayBetweenApplications } = config.behavior;
  const maxPages = config.behavior?.maxPages || 5;

  let applied = 0;
  let skipped = 0;
  let errors = 0;
  let alreadyApplied = 0;
  let internalSkipped = 0;
  let seq = 0;
  const failedJobIds = new Set(); // Track failed jobs to prevent retrying same job endlessly

  function recordAndNotify({ status, jobId, jobTitle, company, jobUrl, skipReason, errorMessage, steps, source }) {
    state.recordApplication({
      platform: 'linkedin', jobId, jobTitle, company, jobUrl,
      status, errorMessage, skipReason, runId, source: source || null,
    });
    seq++;
    queueAppNotification({
      status, company, jobTitle, jobId, steps: steps || 0,
      dsFills: 0, skipReason, errorMessage, sessionId, seq,
      source: source || 'organic', dryRun,
    }, logger);
  }

  function recordOutcome(outcome) {
    recordAndNotify(outcome);
    if (outcome.status === 'submitted' || outcome.status === 'dry_run') applied++;
    else if (outcome.status === 'skipped') skipped++;
    else if (outcome.status === 'already_applied') alreadyApplied++;
    else if (outcome.status === 'error') errors++;
  }

  // ── Crash diagnostics + recovery flag ──
  // The redesigned /jobs/search-results/ SPA grows the renderer heap on each
  // card click (no virtualization, accumulated React state). Without the
  // preemptive reload below, dry-runs reproducibly crashed after 3-6 cards.
  let pageCrashed = false;
  page.on('crash', () => {
    pageCrashed = true;
    logger.error({ platform: 'linkedin' }, 'Page crashed');
  });
  page.context().on('close', () => {
    logger.warn({ platform: 'linkedin' }, 'Browser context closed');
  });

  // ── Navigate to search results ──
  const searchUrl = buildLinkedInSearchUrl(config);
  logger.info({ platform: 'linkedin', searchUrl }, 'Navigating to LinkedIn search');

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000, 5000);

  let currentPage = 1;
  let cardsSinceReload = 0;
  let abortPlatformRun = false;
  const RELOAD_EVERY_CARDS = config.behavior?.linkedinReloadEveryCards || 5;

  while (applied < maxApplications && currentPage <= maxPages) {
    // ── List result cards on current page (top-level page) ──
    let cards;
    try {
      cards = await listResultCards(page);
    } catch (_) {
      logger.warn({ platform: 'linkedin', page: currentPage }, 'Could not find result cards — may have reached end');
      break;
    }

    logger.info({ platform: 'linkedin', page: currentPage, cardCount: cards.length }, `Processing page ${currentPage}`);
    if (cards.length === 0) {
      // Capture page state so the next operator (or Claude session) can see
      // exactly why we found nothing. Pre-fix this branch logged only
      // `cardCount: 0` and exited — five days of zero applications passed
      // before anyone could tell whether it was a DOM change, a login
      // bounce, a bot challenge, or a daily cap.
      const state = await captureSearchPageState(page);
      if (state) {
        const diag = analyzeSearchPageState(state);
        const screenshotPath = await screenshotDebug(page, `nocards-page${currentPage}`);
        logger.warn({
          platform: 'linkedin',
          page: currentPage,
          diagnosticKind: diag.kind,
          diagnosticMessage: diag.message,
          finalUrl: state.url,
          pageTitle: state.title,
          easyApplyCardCount: state.easyApplyCardCount,
          liCardCount: state.liCardCount,
          jobIdAttrCount: state.jobIdAttrCount,
          jobLinkCount: state.jobLinkCount,
          totalButtons: state.totalButtons,
          cardClassCandidates: state.cardClassCandidates,
          verifiedJobAncestors: state.verifiedJobAncestors,
          bodyTextSample: state.bodyText.slice(0, 600),
          screenshotPath,
        }, 'No result cards found — capturing page diagnostic');
      } else {
        logger.warn({ platform: 'linkedin', page: currentPage }, 'No result cards and could not capture page state');
      }
      break;
    }

    for (let i = 0; i < cards.length && applied < maxApplications; i++) {
      // ── Preemptive renderer reload ──
      // Reset the SPA's accumulated state before it crashes. We reload at
      // the TOP of an iteration (no card in flight) so we never orphan an
      // apply flow. The crash flag also kicks the loop into recovery if the
      // renderer died mid-iteration.
      if (pageCrashed || cardsSinceReload >= RELOAD_EVERY_CARDS) {
        const reason = pageCrashed ? 'crash_recovery' : 'preemptive_reload';
        logger.info({
          platform: 'linkedin', page: currentPage,
          cardsSinceReload, reason,
        }, 'Reloading search page to reset renderer');
        try {
          const reloadUrl = currentPage > 1
            ? `${searchUrl}&start=${(currentPage - 1) * 25}`
            : searchUrl;
          await page.goto(reloadUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(3000, 5000);
        } catch (e) {
          logger.warn({ platform: 'linkedin', error: e.message }, 'Reload failed; ending platform run');
          abortPlatformRun = true;
          break;
        }
        pageCrashed = false;
        cardsSinceReload = 0;
        try {
          cards = await listResultCards(page);
        } catch (e) {
          logger.warn({ platform: 'linkedin', error: e.message }, 'Could not re-list result cards after reload; ending platform run');
          abortPlatformRun = true;
          break;
        }
        if (cards.length === 0) {
          logger.warn({ platform: 'linkedin', page: currentPage }, 'Reload returned no result cards; ending platform run');
          abortPlatformRun = true;
          break;
        }
        i = -1;
        continue;
      }

      const card = cards[i];
      let jobId = null;
      let jobTitle = null;
      let company = null;
      let jobUrl = null;
      let source = 'organic';

      try {
        // ── Step 1: Parse card text (hints only) ──
        const rawText = await card.innerText().catch(() => '');
        const summary = summarizeResultCard(rawText);

        if (!summary) {
          logger.debug({ platform: 'linkedin', cardIdx: i, reason: 'card_not_rendered' }, 'Skipping unloaded card');
          internalSkipped++;
          continue;
        }

        jobTitle = summary.title;
        company = summary.company;

        // Early-skip: card shows "Applied" badge
        if (summary.hasAppliedBadge) {
          internalSkipped++;
          continue;
        }

        // ── Step 2: Job filter (before clicking into detail) ──
        const { apply: passFilter, skipReason: filterReason } = shouldApply(jobTitle, company, summary.location, config);
        if (!passFilter) {
          logger.debug({ platform: 'linkedin', jobTitle, company, reason: filterReason }, 'Filtered out');
          // We don't have jobId yet — record with title as identifier
          recordOutcome({ status: 'skipped', jobId: 'filtered', jobTitle, company, skipReason: filterReason, source });
          continue;
        }

        // ── Step 3: Click card to load detail ──
        await selectCard(card);
        cardsSinceReload++;

        // ── Step 4: Extract detail (jobId, promoted, easyApply) ──
        const detail = await extractSelectedJobDetail(page);
        if (!detail || !detail.jobId) {
          logger.debug({ platform: 'linkedin', jobTitle, company, reason: 'no_job_id' }, 'Could not extract job ID from detail');
          internalSkipped++;
          continue;
        }

        jobId = detail.jobId;
        jobUrl = detail.jobUrl;
        source = detail.isPromoted ? 'promoted' : 'organic';

        // Prefer detail-level title/company if available
        if (detail.title) jobTitle = detail.title;
        if (detail.company) company = detail.company;

        // ── Re-run job filter with canonical company name ──
        // summarizeResultCard can mis-parse company on promoted/non-standard
        // cards (the 14-day audit found 13/176 submitted jobs went to
        // blocked staffing firms like BeaconFire — every one had a real
        // company name only visible in the detail panel, never re-checked).
        const recheck = shouldApply(jobTitle, company, summary.location, config);
        if (!recheck.apply) {
          logger.debug({
            platform: 'linkedin', jobId, jobTitle, company,
            reason: recheck.skipReason,
          }, 'Filtered out on post-detail re-check');
          recordOutcome({
            status: 'skipped', jobId, jobTitle, company, jobUrl,
            skipReason: `${recheck.skipReason}:post_detail`,
            source,
          });
          continue;
        }

        // Promoted jobs: tag source but do NOT skip — many are real jobs from real companies.
        // source is already set to 'promoted' above for tracking/analysis.

        // ── Guard: skip jobs that already failed this session ──
        if (failedJobIds.has(jobId)) {
          logger.debug({ platform: 'linkedin', jobId, reason: 'already_failed_this_session' }, 'Skipping');
          internalSkipped++;
          continue;
        }

        // ── Step 5: DB dedup (now that we have canonical jobId) ──
        if (state.hasApplied('linkedin', jobId)) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, reason: 'already_applied_db' }, 'Skipping');
          recordOutcome({ status: 'already_applied', jobId, jobTitle, company, jobUrl, skipReason: 'already_applied_db', source });
          continue;
        }

        // ── Step 5b: repost cooldown (spec R5) ──
        // Repost farms mint new jobIds for the same listing daily — 22.8% of
        // all historical submissions were normalized company+title repeats
        // (ATC "Data Analyst" x71). jobId dedup cannot catch them.
        const cooldownDays = config.search?.jobFilter?.repostCooldownDays ?? 30;
        const companyCap = config.search?.jobFilter?.companyMonthlyCap ?? 5;
        if (state.hasRecentCompanyTitleApplication({ platform: 'linkedin', company, jobTitle, days: cooldownDays })) {
          logger.info({ platform: 'linkedin', jobId, jobTitle, company, reason: 'repost_cooldown' }, 'Skipping repost');
          recordOutcome({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: `repost_cooldown:${cooldownDays}d`, source });
          continue;
        }

        // ── Step 5c: failure cooldown (2026-07-28 review) ──
        // Errored / guard-abandoned forms fail identically on re-attempt, but
        // failures were invisible to dedup: Kobie's 7 same-day "AI Engineer"
        // clones each burned a full form attempt on the same attestation form.
        const failureCooldownDays = config.search?.jobFilter?.failureCooldownDays ?? 14;
        if (state.hasRecentFailure({ platform: 'linkedin', jobId, company, jobTitle, days: failureCooldownDays })) {
          logger.info({ platform: 'linkedin', jobId, jobTitle, company, reason: 'failure_cooldown' }, 'Skipping — recently failed on this job or an identical posting');
          recordOutcome({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: `failure_cooldown:${failureCooldownDays}d`, source });
          continue;
        }

        const recentToCompany = state.getCompanyRecentAttemptCount({ platform: 'linkedin', company, days: cooldownDays });
        if (recentToCompany >= companyCap) {
          logger.info({ platform: 'linkedin', jobId, jobTitle, company, recentToCompany, reason: 'company_cap' }, 'Skipping — company cap reached');
          recordOutcome({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: `company_cap:${recentToCompany}in${cooldownDays}d`, source });
          continue;
        }

        // Already applied per LinkedIn's detail panel
        if (detail.alreadyApplied) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, reason: 'already_applied_linkedin' }, 'Skipping');
          recordOutcome({ status: 'already_applied', jobId, jobTitle, company, jobUrl, skipReason: 'already_applied_linkedin', source });
          continue;
        }

        // ── Step 6: Enter Easy Apply ──
        if (!detail.easyApplyHref) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, reason: 'no_easy_apply_button' }, 'Skipping');
          recordOutcome({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: 'no_easy_apply_button', source });
          continue;
        }

        logger.info({ jobId, jobTitle, company, source }, 'Entering Easy Apply');
        const entryResult = await enterEasyApply(page, logger);

        if (entryResult === 'already_applied') {
          recordOutcome({ status: 'already_applied', jobId, jobTitle, company, jobUrl, skipReason: 'already_applied_linkedin', source });
          continue;
        }
        if (entryResult === 'no_easy_apply') {
          recordOutcome({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: 'no_easy_apply_button', source });
          continue;
        }

        // ── Check for daily limit message (check both page and shadow DOM) ──
        const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const shadowText = await page.evaluate(() => {
          const interop = document.querySelector('#interop-outlet');
          return interop?.shadowRoot?.textContent || '';
        }).catch(() => '');
        if (hasLinkedInDailySubmissionLimitMessage(pageText) || hasLinkedInDailySubmissionLimitMessage(shadowText)) {
          logger.warn({ platform: 'linkedin', applied, jobId, jobTitle }, 'Daily submission limit — ending session');
          recordOutcome({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: 'daily_limit_reached', source });
          return { applied, skipped, errors, alreadyApplied, internalSkipped, stopSession: true, stopSessionReason: 'linkedin_daily_submission_limit' };
        }

        // ── Step 7: Process inline apply steps ──
        const llmBudget = { callsRemaining: 5, msRemaining: 20000 };
        const fillOptions = {
          jobContext: { jobTitle, company, jobDescription: detail.description || '' },
          llmCache: llmCache || undefined,
          llmBudget,
          runId,
          guardBlockedLabels: new Set(),
        };

        let stepCount = 0;
        let applyComplete = false;
        const seenFingerprints = new Set();
        const MAX_STEPS = 12;

        while (!applyComplete && stepCount < MAX_STEPS) {
          stepCount++;

          // Fingerprint step by labels in the shadow DOM apply form
          const fingerprint = await page.evaluate(() => {
            const interop = document.querySelector('#interop-outlet');
            const sr = interop?.shadowRoot;
            if (!sr) return '';
            const labels = [];
            for (const lbl of sr.querySelectorAll('label, legend')) {
              const t = (lbl.textContent || '').trim().substring(0, 60);
              if (t) labels.push(t);
            }
            return labels.sort().join('||');
          }).catch(() => '');

          if (fingerprint && seenFingerprints.has(fingerprint)) {
            // Surface the actual unfilled labels — pre-fix the throw gave us
            // no signal about which fields the agent couldn't resolve.
            const labels = fingerprint.split('||').filter(Boolean).slice(0, 12);

            // Attribute the cycle: an unchecked Top Choice box under policy
            // 'never' means the form is blocked by boost consent, not by an
            // unanswerable question (spec R14 — user decides, see spec
            // open question 4).
            const topChoiceBlocked = await page.evaluate(() => {
              const sr = document.querySelector('#interop-outlet')?.shadowRoot;
              if (!sr) return false;
              for (const cb of sr.querySelectorAll('input[type="checkbox"]')) {
                if (cb.checked) continue;
                const label = cb.id ? sr.querySelector(`label[for="${cb.id}"]`) : null;
                const t = (label?.textContent || '').toLowerCase();
                if (t.includes('top choice') || (t.includes('mark') && t.includes('job'))) return true;
              }
              return false;
            }).catch(() => false);

            logger.warn({
              jobId, jobTitle, company,
              stepNum: stepCount,
              unfilledLabels: labels,
              topChoiceBlocked,
            }, 'Apply flow cycled — unfilled required fields (label diagnostic)');
            const cycleErr = new Error(topChoiceBlocked
              ? 'top_choice_required_review — form blocked on boost checkbox, policy is never-spend'
              : 'Apply flow cycled — unfilled required fields');
            if (fillOptions.guardBlockedLabels.size > 0) {
              cycleErr.guardedAbandonment = [...fillOptions.guardBlockedLabels];
            } else if (topChoiceBlocked) {
              cycleErr.policyAbandonment = 'top_choice_required';
            }
            throw cycleErr;
          }
          if (fingerprint) seenFingerprints.add(fingerprint);

          const result = await handleInlineApplyStep(page, defaultAnswers, config, logger, jobId, dryRun, stepCount, fillOptions);

          if (result === 'retry_failed') {
            const valErr = new Error(`Validation errors on step ${stepCount} — retry failed`);
            if (fillOptions.guardBlockedLabels.size > 0) {
              valErr.guardedAbandonment = [...fillOptions.guardBlockedLabels];
            }
            throw valErr;
          } else if (result === 'submitted') {
            applyComplete = true;

            if (!dryRun) {
              // Wait for success confirmation
              await page.waitForSelector(
                'text="Application submitted", text="Your application was sent"',
                { timeout: 10000 }
              ).catch(() => null);
            }

            logger.info({ jobId, jobTitle, company, steps: stepCount }, 'Application submitted');
            recordOutcome({ status: dryRun ? 'dry_run' : 'submitted', jobId, jobTitle, company, jobUrl, steps: stepCount, source });

            // Dismiss post-submit UI
            await sleep(1000, 2000);
            for (const sel of ['button[aria-label="Dismiss"]', 'button:has-text("Done")', 'button:has-text("Not now")']) {
              try {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0 && await loc.isVisible()) {
                  await loc.evaluate(e => e.click());
                  await sleep(500, 1000);
                  break;
                }
              } catch (_) {}
            }

          } else if (result === 'error') {
            throw new Error(`Could not navigate apply step ${stepCount}`);
          }
        }

        if (!applyComplete) {
          throw new Error(`Apply flow exceeded ${MAX_STEPS} steps without submitting`);
        }

        // Delay between applications
        if (dryRun) await sleep(1000, 3000);
        else await sleep(minDelayBetweenApplications, maxDelayBetweenApplications);

      } catch (err) {
        // Try to recover — dismiss any open apply UI
        try { await page.evaluate(() => document.activeElement?.blur()).catch(() => {}); } catch (_) {}
        try {
          // Try dismissing in both the apply frame and the top-level page
          for (const ctx of [page]) {
            const dismissBtn = await ctx.$('button[aria-label="Dismiss"]');
            if (dismissBtn) {
              await dismissBtn.evaluate(e => e.click());
              await sleep(500, 1000);
              const discardBtn = await ctx.$('button:has-text("Discard")');
              if (discardBtn) { await discardBtn.evaluate(e => e.click()); await sleep(500, 1000); }
              break;
            }
          }
        } catch (_) {}

        await sleep(1000, 2000);

        if (jobId) failedJobIds.add(jobId);

        // Honest abandonment is a skip, not breakage (spec: 'error' must mean
        // the agent broke, not that it refused to fabricate an answer).
        const guardedLabels = Array.isArray(err.guardedAbandonment) ? err.guardedAbandonment : null;
        if (guardedLabels && guardedLabels.length > 0) {
          const labelSummary = guardedLabels
            .map(l => String(l).replace(/\s+/g, ' ').trim().substring(0, 40))
            .slice(0, 3).join(' | ');
          logger.info({ platform: 'linkedin', jobId, jobTitle, guardedFieldCount: guardedLabels.length, labels: labelSummary }, 'Abandoned honestly — required fields are guard-refused');
          recordOutcome({ status: 'skipped', jobId: jobId || 'unknown', jobTitle, company, jobUrl, skipReason: `guarded_required_field:${labelSummary}`, source });
        } else if (err.policyAbandonment === 'top_choice_required') {
          logger.info({ platform: 'linkedin', jobId, jobTitle }, 'Abandoned — form requires Top Choice boost, policy is never-spend');
          recordOutcome({ status: 'skipped', jobId: jobId || 'unknown', jobTitle, company, jobUrl, skipReason: 'top_choice_required', source });
        } else {
          logger.error({ platform: 'linkedin', jobId, jobTitle, error: err.message }, 'Application error');
          await screenshotError(page, 'linkedin', jobId, config);
          recordOutcome({ status: 'error', jobId: jobId || 'unknown', jobTitle, company, jobUrl, errorMessage: err.message, source });
        }
      }

    }

    if (abortPlatformRun) break;

    // ── Pagination ──
    if (applied < maxApplications && currentPage < maxPages) {
      const navigated = await goToNextPage(page, currentPage, logger);
      if (!navigated) break;
      currentPage++;
      await sleep(2000, 4000);
    } else {
      break;
    }
  }

  return { applied, skipped, errors, alreadyApplied, internalSkipped };
}

module.exports = {
  applyLinkedIn,
  // Exported for testing
  buildLinkedInSearchUrl,
  summarizeResultCard,
  shouldApply,
  isRemoteLocation,
  fillShadowForm,
  hasLinkedInDailySubmissionLimitMessage,
  normalizeVisibleText,
  analyzeSearchPageState,
  pickCardStrategy,
  isJobCardText,
  APPLY_LINK_ARIA_LABELS,
  buildApplyLinkSelector,
};
