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
const { fillForm, retryInvalidFields, normalizeLabel } = require('../lib/form-filler');
const { recordUnfilledField, recordFillAudit } = require('../lib/state');
const { queueAppNotification } = require('../lib/notify');
const { guardAnswer, GUARDED_PATTERN_SOURCES } = require('../lib/answer-policy');
const { validateAnswer, VALIDATOR_PATTERN_SOURCES } = require('../lib/output-validator');

const SELECTOR_TIMEOUT = 10000;

// ── Apply-control aria-labels ──
//
// LinkedIn has churned this control twice:
// - 2026-04-26: <a aria-label="Easy Apply to this job"> renamed to
//   <a aria-label="LinkedIn Apply to this job" href=".../apply/?openSDUIApplyFlow=...">
// - 2026-08-13: the anchor became a BUTTON with the legacy label restored —
//   <button aria-label="Easy Apply to this job" type="button">Easy Apply</button>
//   (probe captured 2026-08-21; no apply anchor exists anywhere on the page).
//   Anchor-only matching produced 9 days of no_easy_apply_button on every job.
// Match both tags for every known label. External-apply jobs render
// <button aria-label="Apply on company website"> and must NOT match.
const APPLY_LINK_ARIA_LABELS = [
  'LinkedIn Apply to this job',
  'Easy Apply to this job',
];

function buildApplyLinkSelector() {
  return APPLY_LINK_ARIA_LABELS
    .map(label => `a[aria-label="${label}"], button[aria-label="${label}"]`)
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
  topChoice: { present: false, checked: false, policyBlocked: false },
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
      return { filled: 0, unfilled: [], blocked: [], guardedPending: [], fills: [], topChoice: { present: false, checked: false, policyBlocked: false } };
    }
    const sr = interop.shadowRoot;

    let filled = 0;
    const unfilled = [];
    const blocked = [];
    const guardedPending = [];
    const fills = [];
    const topChoice = { present: false, checked: false, policyBlocked: false };

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
      const ariaLabel = (el.getAttribute('aria-label') || '').trim();
      if (ariaLabel) return ariaLabel;
      const labelledBy = String(el.getAttribute('aria-labelledby') || '').trim();
      if (labelledBy) {
        const parts = [];
        for (const refId of labelledBy.split(/\s+/)) {
          const ref = [...sr.querySelectorAll('[id]')]
            .find((candidate) => candidate.getAttribute('id') === refId);
          const text = (ref?.textContent || '').trim();
          if (text) parts.push(text);
        }
        if (parts.length > 0) return parts.join(' ');
      }
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
      const isTopChoice = /\btop choice\b/.test(labelLower);

      if (isTopChoice) {
        // LinkedIn's boost checkbox. Policy-driven (spec R14): default is
        // 'never' — do not consume Top Choice credits. 'always' opts in.
        topChoice.present = true;
        if (topChoicePolicy === 'always') {
          if (!cb.checked) {
            cb.click();
            if (cb.checked) {
              filled++;
              fills.push({ label: labelText, type: 'checkbox', answer: 'checked', source: 'platform_policy:top_choice', matchType: 'policy_always' });
            } else {
              topChoice.policyBlocked = true;
            }
          }
        } else if (cb.checked) {
          // LinkedIn may preselect a boost. `never` is an active prohibition,
          // so clear it and refuse to continue if the controlled UI rejects
          // the change.
          cb.click();
          if (cb.checked) {
            topChoice.policyBlocked = true;
          } else {
            fills.push({ label: labelText, type: 'checkbox', answer: 'unchecked', source: 'platform_policy:top_choice', matchType: 'policy_never_correction' });
          }
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

    // Apply control — since 2026-08-13 a <button aria-label="Easy Apply to
    // this job"> with no href; before that an <a> with an /apply/ href.
    // Match both tags and both known labels; expose a presence flag since
    // the button variant carries no href.
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 ||
          rect.left >= innerWidth || rect.top >= innerHeight) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    const easyApplyControl = [...document.querySelectorAll(
      'a[aria-label="LinkedIn Apply to this job"], a[aria-label="Easy Apply to this job"], ' +
      'button[aria-label="LinkedIn Apply to this job"], button[aria-label="Easy Apply to this job"]'
    )].find(isVisible) || null;
    const easyApplyHref = (easyApplyControl && easyApplyControl.href) || null;
    const hasEasyApply = !!easyApplyControl;

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

    return { jobId, jobUrl, title, company, isPromoted, alreadyApplied, easyApplyHref, hasEasyApply, description };
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
  const easyApplyLink = await firstVisibleLocator(page.locator(buildApplyLinkSelector()));
  if (easyApplyLink) {
    await easyApplyLink.click({ force: true });
    await sleep(2000, 3000);
    return 'entered';
  }

  // Fallback: try button-based Easy Apply (old UI or A/B variant)
  const easyApplyBtn = await firstVisibleLocator(page.locator('button:has-text("Easy Apply")'));
  if (easyApplyBtn) {
    const text = await easyApplyBtn.innerText().catch(() => '');
    if (text.toLowerCase().includes('applied')) return 'already_applied';
    await easyApplyBtn.click({ force: true });
    await sleep(2000, 3000);
    return 'entered';
  }

  return 'no_easy_apply';
}

async function collectApplyValidationErrors(page) {
  await markActiveApplyDialog(page);
  return page.evaluate(() => {
    const roots = [];
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    const activeDialog = document.querySelector('dialog[data-agent-active-apply="true"]');
    const interop = document.querySelector('#interop-outlet');
    if (activeDialog) roots.push(activeDialog);
    else if (interop && interop.shadowRoot) roots.push(interop.shadowRoot);
    const errors = [];

    function add(text) {
      const normalized = String(text || '').replace(/\s+/g, ' ').trim();
      if (normalized && normalized.length > 3 && normalized.length < 220) {
        errors.push(normalized.substring(0, 160));
      }
    }

    const validationSignals = [
      'please enter a valid answer',
      'please make a selection',
      'enter a decimal number',
      'enter a number',
      'veuillez saisir une reponse valable',
      'effectuez une selection',
    ];
    for (const root of roots) {
      for (const el of root.querySelectorAll('[class*="error"], [role="alert"], [class*="invalid"]')) {
        if (!isVisible(el)) continue;
        add(el.textContent || '');
      }

      const exposedText = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && isVisible(node.parentElement)) exposedText.push(node.textContent || '');
      }
      const rootText = exposedText.join(' ');
      const asciiText = (rootText || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
      for (const signal of validationSignals) {
        if (asciiText.includes(signal)) add(signal);
      }
    }

    return [...new Set(errors)];
  }).catch(() => []);
}

async function detectTopChoiceBlocked(page) {
  await markActiveApplyDialog(page);
  return page.evaluate(() => {
    const roots = [];
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    const activeDialog = document.querySelector('dialog[data-agent-active-apply="true"]');
    const sr = document.querySelector('#interop-outlet')?.shadowRoot;
    if (activeDialog) roots.push(activeDialog);
    else if (sr) roots.push(sr);

    const accessibleName = (root, cb) => {
      const treeDistance = (a, b) => {
        const ancestors = new Map();
        let current = a;
        let distance = 0;
        while (current) { ancestors.set(current, distance++); current = current.parentNode || current.host; }
        current = b;
        distance = 0;
        while (current) {
          if (ancestors.has(current)) return ancestors.get(current) + distance;
          distance++;
          current = current.parentNode || current.host;
        }
        return Number.MAX_SAFE_INTEGER;
      };
      const closestVisible = (candidates) => candidates
        .filter(isVisible)
        .sort((a, b) => treeDistance(cb, a) - treeDistance(cb, b))[0] || null;
      const labels = cb.id
        ? [...root.querySelectorAll('label[for]')]
          .filter((candidate) => candidate.getAttribute('for') === cb.id)
        : [];
      const label = closestVisible(labels) || cb.closest('label');
      const ariaParts = [];
      for (const refId of String(cb.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        const ref = closestVisible(
          [...root.querySelectorAll('[id]')]
            .filter((candidate) => candidate.getAttribute('id') === refId)
        );
        if (ref?.textContent?.trim()) ariaParts.push(ref.textContent.trim());
      }
      return {
        text: [cb.getAttribute('aria-label'), ariaParts.join(' '), label?.textContent]
          .filter(Boolean).join(' ').toLowerCase(),
        exposed: isVisible(cb) || !!(label && isVisible(label)) || ariaParts.length > 0,
      };
    };

    for (const root of roots) {
      for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
        if (cb.checked) continue;
        const name = accessibleName(root, cb);
        if (!name.exposed) continue;
        const t = name.text;
        const isTopChoice = /\btop choice\b/.test(t);
        if (!isTopChoice) continue;
        const explicitlyRequired = cb.required || cb.getAttribute('aria-required') === 'true' ||
          cb.getAttribute('aria-invalid') === 'true' || cb.matches(':invalid');
        if (explicitlyRequired) return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function inspectTopChoiceState(page) {
  await markActiveApplyDialog(page);
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    const activeDialog = document.querySelector('dialog[data-agent-active-apply="true"]');
    const root = activeDialog || document.querySelector('#interop-outlet')?.shadowRoot;
    if (!root) return { present: false, checked: false };

    const accessibleName = (cb) => {
      const treeDistance = (a, b) => {
        const ancestors = new Map();
        let current = a;
        let distance = 0;
        while (current) { ancestors.set(current, distance++); current = current.parentNode || current.host; }
        current = b;
        distance = 0;
        while (current) {
          if (ancestors.has(current)) return ancestors.get(current) + distance;
          distance++;
          current = current.parentNode || current.host;
        }
        return Number.MAX_SAFE_INTEGER;
      };
      const closestVisible = (candidates) => candidates
        .filter(isVisible)
        .sort((a, b) => treeDistance(cb, a) - treeDistance(cb, b))[0] || null;
      const labels = cb.id
        ? [...root.querySelectorAll('label[for]')]
          .filter((candidate) => candidate.getAttribute('for') === cb.id)
        : [];
      const label = closestVisible(labels) || cb.closest('label');
      const ariaParts = [];
      for (const refId of String(cb.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        const ref = closestVisible(
          [...root.querySelectorAll('[id]')]
            .filter((candidate) => candidate.getAttribute('id') === refId)
        );
        if (ref?.textContent?.trim()) ariaParts.push(ref.textContent.trim());
      }
      return {
        text: [cb.getAttribute('aria-label'), ariaParts.join(' '), label?.textContent]
          .filter(Boolean).join(' ').toLowerCase(),
        exposed: isVisible(cb) || !!(label && isVisible(label)) || ariaParts.length > 0,
      };
    };

    let present = false;
    let checked = false;
    for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
      const name = accessibleName(cb);
      if (!name.exposed) continue;
      const text = name.text;
      if (!/\btop choice\b/.test(text)) continue;
      present = true;
      if (cb.checked) checked = true;
    }
    return { present, checked };
  }).catch(() => ({ present: false, checked: false }));
}

async function detectTopChoiceSelected(page) {
  return (await inspectTopChoiceState(page)).checked;
}

async function markActiveApplyDialog(page) {
  return page.evaluate(() => {
    const marker = 'data-agent-active-apply';
    const dialogs = [...document.querySelectorAll('dialog')].reverse();
    for (const dialog of dialogs) dialog.removeAttribute(marker);
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 ||
          rect.left >= innerWidth || rect.top >= innerHeight) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            style.pointerEvents === 'none' || current.hidden || current.inert ||
            current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    const visibleDialogs = dialogs.filter(isVisible);
    const focusedDialog = document.activeElement?.closest?.('dialog');
    const pointDialogFor = (element) => {
      if (!(element instanceof Element)) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return document.elementFromPoint(
        Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
        Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
      )?.closest?.('dialog') || null;
    };
    const focusedHitDialog = visibleDialogs.includes(focusedDialog)
      ? (pointDialogFor(document.activeElement) || pointDialogFor(focusedDialog))
      : null;
    const hitDialog = visibleDialogs.map((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return document.elementFromPoint(
        Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
        Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
      )?.closest?.('dialog');
    }).find((dialog) => visibleDialogs.includes(dialog));
    const focusedModal = visibleDialogs.includes(focusedDialog) &&
      focusedDialog.matches?.(':modal') ? focusedDialog : null;
    // A focused control can remain in a visually covered non-modal dialog.
    // Prefer the actual hit-tested layer unless focus belongs to the browser's
    // native modal top layer.
    const focusedOwner = visibleDialogs.includes(focusedDialog) &&
      focusedHitDialog === focusedDialog ? focusedDialog : null;
    const focusedCover = visibleDialogs.includes(focusedHitDialog) &&
      focusedHitDialog !== focusedDialog ? focusedHitDialog : null;
    const active = focusedModal || focusedCover || focusedOwner || hitDialog ||
      (visibleDialogs.includes(focusedDialog) && focusedDialog) ||
      visibleDialogs.find(d => d.hasAttribute('open')) || visibleDialogs[0];
    if (!active) return false;
    active.setAttribute(marker, 'true');
    return true;
  }).catch(() => false);
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
// ── 2026-08 dialog UI: custom radio-group questions ──
//
// Screener questions render as a <p> question text followed by
// <fieldset role="radiogroup"> holding div[role="radio"] options
// (aria-label "Yes"/"No", aria-checked). The native input[type=radio]
// inside each option is INVISIBLE, so fillForm's radio tier never sees
// these — every questionnaire page jammed with "This field is required".
// Answers resolve through the standard tiers (guard → defaultAnswers →
// rules → budgeted LLM) and must match an option label to be clicked.

const DEGREE_RANKS = [
  [/high school|ged/, 0],
  [/associate/, 1],
  [/\b(?:bachelor|undergraduate)\b/, 2],
  [/\b(?:master|m\.?\s*b\.?\s*a\.?)\b/, 3],
  [/\b(?:ph\.?\s*d\.?|doctor)\b/, 4],
];

function degreeRank(text) {
  return degreeRanks(text)[0] ?? -1;
}

function degreeRanks(text) {
  const t = String(text || '').toLowerCase();
  const ranks = new Set();
  for (const [re, rank] of DEGREE_RANKS) {
    if (re.test(t)) ranks.add(rank);
  }
  const normal = normalizeLabel(t);
  const abbreviationContext = /\b(?:degree|education|highest|earned|completed|obtained|required|requirement|minimum|at least|have (?:a|an))\b/.test(normal);
  const onlyAbbreviation = /^(?:b s|b a|m s|m a)$/.test(normal);
  const dottedBachelor = /\bb\.\s*[sa]\.?(?:\s|$)/.test(t);
  const dottedMaster = /\bm\.\s*[sa]\.?(?:\s|$)/.test(t);
  if (dottedBachelor || ((abbreviationContext || onlyAbbreviation) && /\b(?:b s|b a)\b/.test(normal))) ranks.add(2);
  if (dottedMaster || ((abbreviationContext || onlyAbbreviation) && /\b(?:m s|m a)\b/.test(normal))) ranks.add(3);
  return [...ranks];
}

function canonicalDegreePhrase(text) {
  return normalizeLabel(String(text || ''))
    .replace(/\b(associate|bachelor|master|doctor) s\b/g, '$1')
    .replace(/\b(associates|bachelors|masters|doctors)\b/g, (word) => word.slice(0, -1))
    .replace(/\s+/g, ' ')
    .trim();
}

function degreeQuestionSubject(question) {
  const q = canonicalDegreePhrase(question)
    .replace(/\s+or (?:higher|above)$/, '')
    .trim();
  const patterns = [
    // "the following level of education: X" is LinkedIn's standard education
    // screener boilerplate — strip the filler so the subject is the degree
    // itself, not the wrapper phrase.
    /^(?:do you (?:have|hold|possess)|have you (?:earned|completed|obtained|received|attained|graduated with)|did you (?:earn|complete|obtain|receive|attain|graduate with)) (?:at least )?(?:a |an |the )?(?:following (?:minimum )?(?:level of education|education level|degree) )?(?:a |an |the )?(.+)$/,
    /^is (?:a |an |the )?(.+?) your highest (?:degree|education level|level of education)$/,
    /^is your highest (?:degree|education level|level of education) (?:a |an |the )?(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = q.match(pattern);
    if (match) return match[1].trim();
  }
  return q;
}

function isGenericDegreeSubject(subject) {
  return /^(?:high school(?: diploma)?|ged|associate(?: degree)?|bachelor(?: degree)?|undergraduate(?: degree)?|master(?: degree)?|doctorate(?: degree)?|doctoral degree|ph d|doctor of philosophy)$/.test(subject);
}

function isYesNoOptionSet(labels) {
  const set = labels.map(l => l.trim().toLowerCase()).sort().join('|');
  return set === 'no|yes';
}

function hasUnsafeDialogNegation(text) {
  return /\b(?:not|no|never|without|unable|unwilling|unauthori[sz]ed|cannot|can t|do not|don t|does not|doesn t|will not|won t|have not|haven t|has not|hasn t|lack|lacking)\b/i
    .test(normalizeLabel(String(text || '')));
}

function isIncidentalSensitiveDisclosure(question, questionClass) {
  if (questionClass !== 'sensitive_identity') return false;
  const raw = String(question || '');
  const normal = normalizeLabel(raw);
  const hasDisclosureMarker = /\b(?:voluntary self identification|self identification of disability|you are not required to disclose|form cc 305)\b/
    .test(normal);
  if (!hasDisclosureMarker) return false;
  const directPrompts = raw.split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => {
      const text = normalizeLabel(sentence);
      return /^(?:which|what|are|do|does|did|is|have|has|will|would|can|could)\b/.test(text) ||
        /\b(?:which|what)\b.{0,80}\byou\b/.test(text) ||
        /^(?:please )?(?:select|choose|indicate|identify)\b/.test(text) ||
        /\b(?:select|choose|indicate|identify)\b.{0,120}\b(?:you|your)\b/.test(text) ||
        /\byou\b.{0,120}\b(?:select|choose|indicate|identify)\b/.test(text);
    });
  // Disclosure prose may contain incidental "not/no/or" boilerplate. It may
  // not override an inverse or compound interrogative directed at the user.
  return !directPrompts.some((prompt) =>
    dialogQuestionRequiresExactAnswer(prompt, questionClass)
  );
}

function dialogQuestionRequiresExactAnswer(question, questionClass = '') {
  const normal = normalizeLabel(String(question || ''));
  if (hasUnsafeDialogNegation(normal)) return 'negated_question';
  const recognizedSponsorshipAlternative = /\b(?:a )?work visa or employment authori[sz]ation\b/.test(normal) ||
    /\bvisa sponsorship or (?:a )?visa transfer\b/.test(normal) ||
    /\bh 1b or other employment based immigration (?:case|support)\b/.test(normal);
  const compoundProbe = normal
    .replace(/\bnow or in the future\b/g, '')
    .replace(/\b(?:a )?work visa or employment authori[sz]ation\b/g, 'immigration support')
    .replace(/\bvisa sponsorship or (?:a )?visa transfer\b/g, 'visa sponsorship')
    .replace(/\bh 1b or other employment based immigration (?:case|support)\b/g, 'immigration support')
    .replace(/\bor (?:higher|above|older)\b/g, '');
  if (/\b(?:and|or)\b/.test(compoundProbe)) return 'compound_question';
  if (!recognizedSponsorshipAlternative &&
      /\b(?:authori[sz](?:ed|ation)|eligible)\b/.test(normal) && /\bsponsor/.test(normal)) {
    return 'combined_authorization_sponsorship';
  }
  return null;
}

function mapEducationAnswerToYesNo(question, configuredEducation) {
  if (hasUnsafeDialogNegation(question)) return null;
  const askedRanks = degreeRanks(question);
  const configuredRanks = degreeRanks(configuredEducation);
  if (askedRanks.length !== 1 || configuredRanks.length !== 1) return null;
  const asked = askedRanks[0];
  const have = configuredRanks[0];

  const q = canonicalDegreePhrase(question);
  const askedSubject = degreeQuestionSubject(question);
  const configuredSubject = canonicalDegreePhrase(configuredEducation);
  // Only generic level wording may use rank inference. Any discipline,
  // concentration, named credential, or extra phrase must match the complete
  // configured credential literally after punctuation/possessive cleanup.
  if (!isGenericDegreeSubject(askedSubject) && askedSubject !== configuredSubject) return null;
  const isThreshold = /\b(?:at least|or higher|or above|minimum(?:\s+(?:of|required|requirement))?)\b/.test(q);
  if (isThreshold) return have >= asked ? 'Yes' : 'No';

  // "Highest education" is an exact-level question, not a threshold.
  if (/\bhighest\b/.test(q)) return have === asked ? 'Yes' : 'No';

  // Exact matches and a configured highest level below the requested level
  // are safe. A higher rank does not prove that every intermediate degree
  // was separately awarded, so leave that case unanswered.
  if (have === asked) return 'Yes';
  if (have < asked) return 'No';
  return null;
}

function isDeclineToAnswer(text) {
  const normal = normalizeLabel(String(text || ''));
  return /^(?:i )?(?:(?:do not|don t) (?:wish|want) to (?:answer|say|specify|self identify)|prefer not to (?:answer|say|specify|self identify)|decline(?: to)? (?:answer|self identify)|choose not to (?:answer|say|specify|self identify))$/
    .test(normal);
}

function matchDialogRadioOption(options, value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;

  const rawExact = options.filter((option) =>
    String(option.label || '').trim().toLowerCase() === v
  );
  if (rawExact.length === 1) return rawExact[0];
  if (rawExact.length > 1) return null;
  // Punctuation can change numeric semantics (10 vs 10+), so numeric values
  // require literal equality and never use punctuation-normalized matching.
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(v)) return null;

  const normalizedValue = normalizeLabel(v);
  const normalizedExact = options.filter((option) =>
    normalizeLabel(String(option.label || '')) === normalizedValue
  );
  if (normalizedExact.length === 1) return normalizedExact[0];
  if (normalizedExact.length > 1) return null;

  // LinkedIn's standard EEO forms vary the wording of the same explicit
  // opt-out. Keep this equivalence deliberately narrow; it must not reopen
  // general fuzzy matching for submitted demographic or eligibility facts.
  if (isDeclineToAnswer(v)) {
    const optOutOptions = options.filter((option) => isDeclineToAnswer(option.label));
    if (optOutOptions.length === 1) return optOutOptions[0];
  }

  // Substring matching is unsafe for numeric/short choices: answer "10"
  // otherwise matches option "0" or "1" before an exact/range choice.
  if (v.length < 3) return null;
  const candidates = options.filter((o) => {
    const label = String(o.label || '').trim().toLowerCase();
    if (label.length < 3 || /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(label)) return false;
    // Only accept a complete option phrase contained in a more-specific
    // configured answer. Expanding a generic fact such as "Veteran" or
    // "Woman" into a more-qualified option would invent information.
    const normalizedValue = normalizeLabel(v);
    const normalizedOption = normalizeLabel(label);
    if (!normalizedOption) return false;
    const escapedOption = normalizedOption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escapedOption}(?:\\s|$)`).test(normalizedValue);
  });
  const hasNegativePolarity = (text) => /\b(?:no|not|never|without|cannot|can't|unable|unwilling|ineligible|unauthorized|do not|does not|did not|don't|doesn't|didn't|have not|has not|haven't|hasn't|non[-\s]\w+)\b/i.test(text);
  const valueIsNegative = hasNegativePolarity(v);
  const polarityMatches = candidates.filter((o) =>
    hasNegativePolarity(String(o.label || '').toLowerCase()) === valueIsNegative
  );
  // A single polarity-compatible phrase is safe. Multiple remaining phrases
  // can encode facts absent from the answer (for example US vs Canada work
  // authorization), so ambiguity must stay unfilled.
  return polarityMatches.length === 1 ? polarityMatches[0] : null;
}

function exactDialogDefaultAnswer(normalQuestion, answers) {
  for (const [key, value] of Object.entries(answers || {})) {
    if (normalizeLabel(String(key)) === normalQuestion) return value;
  }
  return null;
}

function configuredBooleanChoice(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (/^(?:yes|true)$/i.test(String(value || '').trim())) return 'Yes';
  if (/^(?:no|false)$/i.test(String(value || '').trim())) return 'No';
  return null;
}

function groundedDialogPreference(normalQuestion, config) {
  const user = config.user || {};
  const compoundProbe = normalQuestion.replace(/\bor older\b/g, '');
  if (hasUnsafeDialogNegation(normalQuestion) || /\b(?:and|or)\b/.test(compoundProbe)) return null;
  const mappings = [
    {
      matches: /^(?:are|would) you (?:be )?willing to relocate$/.test(normalQuestion),
      value: user.willingToRelocate,
      source: 'config:user.willingToRelocate',
    },
    {
      matches: /^(?:are|would) you (?:be )?willing to travel$/.test(normalQuestion),
      value: user.willingToTravel,
      source: 'config:user.willingToTravel',
    },
    {
      matches: /^are you (?:able|willing) to commute$/.test(normalQuestion),
      value: user.willingToCommute,
      source: 'config:user.willingToCommute',
    },
    {
      matches: /^(?:are you (?:(?:at least|over) )?18(?: years?(?: old| of age)?)?(?: or older)?|are you over the age of 18)$/.test(normalQuestion),
      value: user.over18,
      source: 'config:user.over18',
    },
    {
      matches: /^(?:do you have|have you got) (?:a )?(?:valid )?driver s licen[cs]e$/.test(normalQuestion),
      value: user.hasDriversLicense,
      source: 'config:user.hasDriversLicense',
    },
  ];
  for (const mapping of mappings) {
    if (!mapping.matches) continue;
    const answer = configuredBooleanChoice(mapping.value);
    if (answer) return { answer, source: mapping.source };
  }
  return null;
}

function configuredSensitiveOptionSetAnswer(question, optionLabels, config) {
  const user = config.user || {};
  const questionText = normalizeLabel(String(question || ''));
  const optionSetText = normalizeLabel((optionLabels || []).join(' '));
  const raceContextText = `${questionText} ${optionSetText}`;
  const optionSetRaceSignals = [
    /\bhispanic or latino\b/,
    /\basian\b/,
    /\bblack or african american\b/,
    /\bwhite\b/,
    /\bamerican indian or alaska native\b/,
    /\bnative hawaiian or other pacific islander\b/,
  ].filter((pattern) => pattern.test(raceContextText)).length;
  const raceSignals = [
    /\bhispanic or latino\b/,
    /\basian\b/,
    /\bblack or african american\b/,
    /\bwhite\b/,
    /\bamerican indian or alaska native\b/,
    /\bnative hawaiian or other pacific islander\b/,
  ].filter((pattern) => pattern.test(questionText)).length;
  const configuredRaceIsOptOut = isDeclineToAnswer(user.race);
  const optOutOptionCount = (optionLabels || []).filter(isDeclineToAnswer).length;
  const positivelyIdentifiedRaceContext = /\b(?:race|ethnicity)\b/.test(questionText) ||
    (optionSetRaceSignals >= 3 && /\bhispanic or latino\b/.test(raceContextText));
  if (user.race && configuredRaceIsOptOut && optOutOptionCount === 1 &&
      positivelyIdentifiedRaceContext) {
    return { answer: user.race, source: 'config:user.race', safeUnderExactOnly: true };
  }
  // Some LinkedIn EEO pages expose only the category definitions, without a
  // standalone "race" label, so the generic guard classifies them unguarded.
  // A multi-category EEO signature plus the explicit user race config is
  // sufficient to choose only that configured option/opt-out.
  const hasDefinitionProse = /\b(?:a person having origins|a person of cuban|original peoples)\b/
    .test(questionText);
  if (user.race && hasDefinitionProse && raceSignals >= 3 &&
      /\bhispanic or latino\b/.test(questionText)) {
    return { answer: user.race, source: 'config:user.race', safeUnderExactOnly: false };
  }
  return null;
}

async function fillDialogRadioGroups(page, defaultAnswers, config, logger, jobId, options = {}) {
  const flatAnswers = defaultAnswers.defaultAnswers || defaultAnswers;
  const runId = options.runId || null;

  // Phase A (in-page): collect unanswered groups, tag options for clicking.
  await markActiveApplyDialog(page);
  const groups = await page.evaluate(() => {
    const found = [];
    let gi = 0;
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    // The dialog retains completed/hidden page templates. Remove tags from
    // prior passes so a reused agent-radio-0-* marker cannot resolve to an
    // already-answered field from an earlier step.
    for (const stale of document.querySelectorAll('dialog [data-agent-radio]')) {
      stale.removeAttribute('data-agent-radio');
    }
    const dlg = document.querySelector('dialog[data-agent-active-apply="true"]');
    if (!dlg || !/pages/i.test(dlg.innerText || '')) return found;
    for (const grp of dlg.querySelectorAll('[role="radiogroup"]')) {
        if (!isVisible(grp)) continue;
        const opts = [...grp.querySelectorAll('[role="radio"]')].filter(isVisible);
        if (opts.length === 0) continue;
        if (opts.some(o => o.getAttribute('aria-checked') === 'true')) continue;
        // Question text: nearest non-empty preceding sibling of the group
        let q = grp.previousElementSibling;
        while (q && !(q.textContent || '').trim()) q = q.previousElementSibling;
        const question = q && isVisible(q) ? q.textContent.trim() : (grp.getAttribute('aria-label') || '');
        const optionInfos = opts.map((o, oi) => {
          const tag = `agent-radio-${gi}-${oi}`;
          o.setAttribute('data-agent-radio', tag);
          return { tag, label: (o.getAttribute('aria-label') || o.innerText || '').trim() };
        });
        found.push({ question, options: optionInfos });
        gi++;
    }
    return found;
  }).catch(() => []);

  let filled = 0;
  for (const group of groups) {
    if (!group.question || group.options.length === 0) continue;
    const optionLabels = group.options.map(o => o.label);
    const label = group.question.substring(0, 200);

    const normalLabel = normalizeLabel(group.question);
    const explicitDefault = exactDialogDefaultAnswer(normalLabel, flatAnswers);
    const sensitiveOptionSetAnswer = configuredSensitiveOptionSetAnswer(
      group.question, optionLabels, config
    );
    let answer = sensitiveOptionSetAnswer?.answer || null;
    let source = sensitiveOptionSetAnswer?.source || null;
    let confidence = sensitiveOptionSetAnswer ? 'config_option_set' : null;

    const guard = guardAnswer(group.question, { config, defaultAnswers: flatAnswers });
    const exactOnlyReason = dialogQuestionRequiresExactAnswer(group.question, guard.questionClass);
    if (exactOnlyReason) {
      const exactChoice = matchDialogRadioOption(group.options, explicitDefault);
      const guardedChoice = guard.action === 'answer'
        ? matchDialogRadioOption(group.options, guard.answer)
        : null;
      const guardedOptOut = guardedChoice && isDeclineToAnswer(guard.answer) &&
        isDeclineToAnswer(guardedChoice.label);
      const guardedCategoricalChoice = !isYesNoOptionSet(optionLabels) && guardedChoice &&
        (guardedOptOut || isIncidentalSensitiveDisclosure(group.question, guard.questionClass));
      const sensitiveOptionSetChoice = sensitiveOptionSetAnswer?.safeUnderExactOnly
        ? matchDialogRadioOption(group.options, sensitiveOptionSetAnswer.answer)
        : null;
      if (!exactChoice && !guardedCategoricalChoice && !sensitiveOptionSetChoice) {
        if (options.guardBlockedLabels) options.guardBlockedLabels.add(label);
        recordFillAudit({
          platform: 'linkedin', jobId, runId, fieldLabel: label, fieldType: 'radio',
          inputType: null, fillSource: 'cannot_fill', answer: '', confidence: `guard:${exactOnlyReason}`,
        });
        recordUnfilledField({ platform: 'linkedin', jobId, fieldLabel: label, fieldType: 'radio' });
        logger.info({
          platform: 'linkedin', jobId, question: label.substring(0, 80), reason: exactOnlyReason,
        }, 'Dialog radio group requires an exact question-specific answer');
        continue;
      }
      if (exactChoice) {
        answer = explicitDefault;
        source = 'defaultAnswers';
        confidence = 'exact_question';
      }
    }

    let hasGuardedAnswer = !!answer;
    if (!answer && guard.action === 'block') {
      const configuredEducation = config.user?.highestEducation;
      const mappedEducation = guard.questionClass === 'education_facts' &&
        configuredEducation && isYesNoOptionSet(optionLabels)
        ? mapEducationAnswerToYesNo(group.question, configuredEducation)
        : null;
      if (mappedEducation) {
        answer = mappedEducation;
        source = 'config:user.highestEducation';
        confidence = 'guard_config_mapped';
        hasGuardedAnswer = true;
      } else {
        if (options.guardBlockedLabels) options.guardBlockedLabels.add(label);
        logger.info({ platform: 'linkedin', jobId, question: label.substring(0, 80), questionClass: guard.questionClass }, 'Guard blocked dialog radio group');
        recordFillAudit({ platform: 'linkedin', jobId, runId, fieldLabel: label, fieldType: 'radio', inputType: null, fillSource: 'cannot_fill', answer: '', confidence: `guard:${guard.reason}` });
        recordUnfilledField({ platform: 'linkedin', jobId, fieldLabel: label, fieldType: 'radio' });
        continue;
      }
    }
    if (!answer && guard.action === 'answer') {
      hasGuardedAnswer = true;
      answer = guard.answer;
      source = guard.source;
      confidence = 'guard_config';
      // Education config stores the highest level as text, while some forms
      // expose Yes/No. Only use rank ordering for explicit threshold wording;
      // a higher degree does not prove every intermediate degree was awarded.
      if (isYesNoOptionSet(optionLabels) && !/^(yes|no)$/i.test(String(answer).trim())) {
        if (guard.questionClass === 'education_facts') {
          answer = mapEducationAnswerToYesNo(group.question, answer);
        }
      }
    }

    const matchOption = (value) => matchDialogRadioOption(group.options, value);

    let chosen = matchOption(answer);

    // Unguarded radio answers must be explicitly question-specific. Generic
    // fuzzy defaults (for example total experience) cannot establish a named
    // skill's tenure, and generic polarity rules cannot establish facts.
    if (!chosen && !hasGuardedAnswer) {
      chosen = matchOption(explicitDefault);
      if (chosen) { source = 'defaultAnswers'; confidence = 'exact_question'; }
      if (!chosen) {
        const preference = groundedDialogPreference(normalLabel, config);
        chosen = preference ? matchOption(preference.answer) : null;
        if (chosen) { source = preference.source; confidence = 'config'; }
      }
    }

    if (!chosen) {
      // Radio answers are submitted facts. An LLM cannot know whether the
      // candidate has a licence, visa/status, or specific experience. Only an
      // explicit/default or config-backed rule may select an option; otherwise
      // classify the refusal as an honest, grounded-answer skip.
      if (options.guardBlockedLabels) options.guardBlockedLabels.add(label);
      const reason = hasGuardedAnswer
        ? 'configured_answer_does_not_match_options'
        : 'no_grounded_radio_answer';
      recordFillAudit({
        platform: 'linkedin', jobId, runId, fieldLabel: label, fieldType: 'radio',
        inputType: null, fillSource: 'cannot_fill', answer: '', confidence: `guard:${reason}`,
      });
      logger.info({
        platform: 'linkedin', jobId, question: label.substring(0, 80),
        questionClass: guard.questionClass, reason,
      }, 'Dialog radio group left unanswered without grounded evidence');
      recordUnfilledField({ platform: 'linkedin', jobId, fieldLabel: label, fieldType: 'radio' });
      logger.debug({ platform: 'linkedin', jobId, question: label.substring(0, 80), answerLength: answer ? String(answer).length : 0, options: optionLabels }, 'No matching option for dialog radio group');
      continue;
    }

    await markActiveApplyDialog(page);
    const radio = page.locator(`dialog[data-agent-active-apply="true"] [data-agent-radio="${chosen.tag}"]`).first();
    const snapshotStillMatches = await radio.evaluate((el, snapshot) => {
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (let current = element; current instanceof Element;) {
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' ||
              style.visibility === 'collapse' || Number(style.opacity) === 0 ||
              current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
          current = current.parentElement || current.getRootNode()?.host || null;
        }
        return true;
      };
      const group = el.closest('[role="radiogroup"]');
      if (!group || !isVisible(group) || !isVisible(el)) return false;
      let questionNode = group.previousElementSibling;
      while (questionNode && !(questionNode.textContent || '').trim()) {
        questionNode = questionNode.previousElementSibling;
      }
      const currentQuestion = questionNode && isVisible(questionNode)
        ? questionNode.textContent.trim()
        : (group.getAttribute('aria-label') || '');
      const currentLabel = (el.getAttribute('aria-label') || el.innerText || '').trim();
      return currentQuestion === snapshot.question && currentLabel === snapshot.optionLabel &&
        el.getAttribute('aria-checked') !== 'true';
    }, { question: group.question, optionLabel: chosen.label }).catch(() => false);
    if (!snapshotStillMatches) {
      if (options.guardBlockedLabels) options.guardBlockedLabels.add(label);
      logger.info({ platform: 'linkedin', jobId, question: label.substring(0, 80) }, 'Dialog radio group changed before selection; recollecting safely');
      continue;
    }
    const clicked = await radio.evaluate((el) => {
      if (el.getAttribute('aria-disabled') === 'true') return false;
      el.click();
      return true;
    }).catch(() => false);
    if (clicked) await sleep(100, 200);
    const selected = clicked && await radio.evaluate((el) =>
      el.getAttribute('aria-checked') === 'true' || !!el.querySelector('input[type="radio"]')?.checked
    ).catch(() => false);
    if (selected) {
      filled++;
      recordFillAudit({ platform: 'linkedin', jobId, runId, fieldLabel: label, fieldType: 'radio', inputType: null, fillSource: source || 'unknown', answer: chosen.label, confidence });
      // The chosen option stays out of logs (self-ID answers are sensitive);
      // fill_audit in the gitignored DB keeps the full value for forensics.
      logger.debug({ platform: 'linkedin', jobId, question: label.substring(0, 80), source }, 'Filled dialog radio group');
      if ((options._dialogRadioDepth || 0) < 8) {
        const nested = await fillDialogRadioGroups(page, defaultAnswers, config, logger, jobId, {
          ...options,
          _dialogRadioDepth: (options._dialogRadioDepth || 0) + 1,
        });
        filled += nested.filled;
      }
      await sleep(200, 500);
    } else {
      // Fail closed: an unselected group is an unfilled field. Recording it
      // as guard-blocked routes a later validation bounce into the honest
      // guarded-abandon classification instead of submitting incomplete.
      if (options.guardBlockedLabels) options.guardBlockedLabels.add(label);
      recordFillAudit({
        platform: 'linkedin', jobId, runId, fieldLabel: label, fieldType: 'radio',
        inputType: null, fillSource: 'cannot_fill', answer: '', confidence: 'guard:radio_click_failed',
      });
      recordUnfilledField({ platform: 'linkedin', jobId, fieldLabel: label, fieldType: 'radio' });
      logger.warn({ platform: 'linkedin', jobId, question: label.substring(0, 80) }, 'Dialog radio click did not select the option');
    }
  }

  if (groups.length > 0) {
    logger.info({ platform: 'linkedin', jobId, groups: groups.length, filled }, 'Dialog radio groups processed');
  }
  return { groups: groups.length, filled };
}

// Fingerprint the active form step. The dialog UI puts radio questions in a
// preceding <p>, not in label/legend, and retains hidden templates; include
// visible question/progress text only.
async function captureApplyStepFingerprint(page) {
  return page.evaluate(() => {
    const roots = [];
    const isVisible = (d) => {
      const rect = d.getBoundingClientRect();
      const style = getComputedStyle(d);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        !d.hidden && d.getAttribute('aria-hidden') !== 'true';
    };
    const activeDialog = document.querySelector('dialog[data-agent-active-apply="true"]');
    if (activeDialog) {
      roots.push(activeDialog);
    } else {
      const sr = document.querySelector('#interop-outlet')?.shadowRoot;
      if (sr) roots.push(sr);
    }
    const labels = [];
    for (const root of roots) {
      for (const lbl of root.querySelectorAll('label, legend')) {
        if (lbl.getClientRects().length === 0) continue;
        const t = (lbl.textContent || '').trim().substring(0, 60);
        if (t) labels.push(t);
      }
      for (const group of root.querySelectorAll('[role="radiogroup"]')) {
        if (group.getClientRects().length === 0) continue;
        let q = group.previousElementSibling;
        while (q && !(q.textContent || '').trim()) q = q.previousElementSibling;
        const t = (q?.textContent || group.getAttribute('aria-label') || '').trim().substring(0, 120);
        if (t) labels.push(t);
      }
      const progress = (root.innerText || '').match(/\b\d+\s*(?:\/|of)\s*\d+\s*pages?\b/i)?.[0];
      if (progress) labels.push(progress);
    }
    return labels.sort().join('||');
  }).catch(() => '');
}

async function waitForSubmissionConfirmation(page, options = {}) {
  const timeout = typeof options === 'number' ? options : (options.timeout ?? 10000);
  const baselineEvidence = typeof options === 'object' ? options.baselineEvidence : null;
  const expectedJobId = typeof options === 'object'
    ? (options.expectedJobId || baselineEvidence?.expectedJobId || null)
    : null;
  const baseline = baselineEvidence || {
    globalCount: 0,
    dialogCounts: {},
    shadowCount: 0,
    liveCount: 0,
    activeDialogId: null,
    hasShadowRoot: false,
  };
  const deadline = Date.now() + timeout;

  try {
    do {
      const current = await captureSubmissionConfirmationEvidence(page, {
        baselineToken: baseline.baselineToken || null,
        baselineSignatures: baseline.baselineSignatures || [],
        expectedJobId,
      });
      const activeDialogAdvanced = current.activeDialogNovelCount > 0;
      const shadowAdvanced = current.shadowNovelCount > 0;
      const liveAdvanced = current.liveNovelCount > 0;
      const activeBaselineCount = current.activeDialogId
        ? (baseline.dialogCounts?.[current.activeDialogId] || 0)
        : 0;
      const activeRawAdvanced = current.activeDialogCount > activeBaselineCount;
      const shadowRawAdvanced = current.shadowCount > (baseline.shadowCount || 0);
      const liveRawAdvanced = current.liveCount > (baseline.liveCount || 0);
      // LinkedIn's August 2026 UI closes the apply dialog and renders plain
      // (non-live-region) text in the selected job detail panel:
      //   Application status / Application submitted / now
      // This is authoritative only when it is new relative to the pre-click
      // baseline and the URL still identifies the job whose Submit was clicked.
      const selectedDetailAdvanced = !!expectedJobId &&
        current.selectedJobMatches === true &&
        current.selectedDetailSubmitted === true &&
        baseline.selectedDetailSubmitted !== true;
      let confirmed;
      if (!baselineEvidence) {
        // Direct helper use has no known originating flow.
        confirmed = activeDialogAdvanced || shadowAdvanced || liveAdvanced;
      } else if (baseline.activeDialogId) {
        // A dialog may confirm in-place, transition to a new confirmation
        // dialog, or close and emit a new global live-region toast. The latter
        // is valid only after the originating dialog has actually disappeared.
        confirmed = (activeDialogAdvanced && activeRawAdvanced) ||
          (!current.baselineOwnerVisible && liveAdvanced && liveRawAdvanced) ||
          selectedDetailAdvanced;
      } else if (baseline.hasShadowRoot) {
        confirmed = shadowAdvanced && shadowRawAdvanced;
      } else {
        confirmed = liveAdvanced && liveRawAdvanced;
      }

      // Scope-local raw growth binds evidence to a real transition without an
      // unrelated result-card rerender masking a legitimate confirmation.
      if (confirmed) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await page.waitForTimeout(Math.min(150, remaining)).catch(() => {});
    } while (Date.now() <= deadline);

    return false;
  } finally {
    if (baseline.baselineToken) {
      await clearSubmissionConfirmationBaseline(page, baseline.baselineToken);
    }
  }
}

async function clearSubmissionConfirmationBaseline(page, baselineToken) {
  if (!baselineToken) return;
  await page.evaluate((token) => {
    const attributes = ['data-agent-confirmation-baseline', 'data-agent-confirmation-owner'];
    const clearRoot = (root) => {
      for (const attribute of attributes) {
        for (const element of root.querySelectorAll(`[${attribute}]`)) {
          if (element.getAttribute(attribute) === token) element.removeAttribute(attribute);
        }
      }
    };
    clearRoot(document);
    const shadowRoot = document.querySelector('#interop-outlet')?.shadowRoot;
    if (shadowRoot) clearRoot(shadowRoot);
  }, baselineToken).catch(() => {});
}

async function captureSubmissionConfirmationEvidence(page, options = {}) {
  await markActiveApplyDialog(page);
  const markBaseline = options.markBaseline === true;
  const baselineToken = options.baselineToken || (markBaseline
    ? `confirmation-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : null);
  const baselineSignatures = Array.isArray(options.baselineSignatures)
    ? options.baselineSignatures
    : [];
  const expectedJobId = options.expectedJobId ? String(options.expectedJobId) : null;
  return page.evaluate(({ markBaseline, baselineToken, baselineSignatures, expectedJobId }) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    const successPattern = /application submitted|your application was (?:sent|submitted)/i;
    // Containers that belong to OTHER jobs (result cards, list items): text
    // inside them must never confirm the current submission.
    const unrelatedResultSelector = [
      'article',
      '[role="article"]',
      '[data-job-id]',
      '[data-occludable-job-id]',
      '[role="listitem"]',
      'li.scaffold-layout__list-item',
      '[class*="job-card-job-posting-card-wrapper"]',
      '[class*="job-card-container"]',
      '[class*="job-card-list"]',
      '[class*="jobs-search-results__list-item"]',
      'div[data-view-name="job-card"]',
      'a[data-control-name*="job_card"]',
      '[role="link"][href*="/jobs/view/"]',
    ].join(', ');
    const dialogIdAttribute = 'data-agent-confirmation-dialog';
    const evidenceAttribute = 'data-agent-confirmation-baseline';
    const ownerAttribute = 'data-agent-confirmation-owner';
    const exposedText = (element) => {
      const parts = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && isVisible(node.parentElement)) parts.push(node.textContent || '');
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    };
    const signature = (element) => exposedText(element).toLowerCase();
    const baselineSignatureSet = new Set(baselineSignatures);
    let nextDialogId = Number(document.documentElement.getAttribute('data-agent-confirmation-seq') || 0);
    const usedDialogIds = new Set();
    for (const dialog of document.querySelectorAll('dialog')) {
      let dialogId = dialog.getAttribute(dialogIdAttribute);
      if (!dialogId || usedDialogIds.has(dialogId)) {
        dialogId = `dialog-${++nextDialogId}`;
        dialog.setAttribute(dialogIdAttribute, dialogId);
      }
      usedDialogIds.add(dialogId);
    }
    document.documentElement.setAttribute('data-agent-confirmation-seq', String(nextDialogId));

    const successLeaves = (root) => [...root.querySelectorAll('*')].filter((el) => {
      if (!isVisible(el) || !successPattern.test(exposedText(el))) return false;
      return ![...el.children].some((child) =>
        isVisible(child) && successPattern.test(exposedText(child))
      );
    });

    const documentEvidence = successLeaves(document);
    const sr = document.querySelector('#interop-outlet')?.shadowRoot;
    const shadowEvidence = sr ? successLeaves(sr) : [];
    const activeDialog = document.querySelector('dialog[data-agent-active-apply="true"]');
    if (markBaseline && baselineToken) {
      for (const element of [...documentEvidence, ...shadowEvidence]) {
        element.setAttribute(evidenceAttribute, baselineToken);
      }
      if (activeDialog) activeDialog.setAttribute(ownerAttribute, baselineToken);
    }
    const capturedSignatures = [...new Set(
      [...documentEvidence, ...shadowEvidence].map(signature).filter(Boolean)
    )];
    const isNovel = (element) => !baselineToken || (
      element.getAttribute(evidenceAttribute) !== baselineToken &&
      !baselineSignatureSet.has(signature(element))
    );
    const shadowCount = shadowEvidence.length;
    const shadowNovelCount = shadowEvidence.filter(isNovel).length;
    const dialogCounts = {};
    const dialogNovelCounts = {};
    let liveCount = 0;
    let liveNovelCount = 0;
    for (const el of documentEvidence) {
      const dialog = el.closest?.('dialog');
      if (dialog) {
        const dialogId = dialog.getAttribute(dialogIdAttribute);
        if (dialogId) dialogCounts[dialogId] = (dialogCounts[dialogId] || 0) + 1;
        if (dialogId && isNovel(el)) {
          dialogNovelCounts[dialogId] = (dialogNovelCounts[dialogId] || 0) + 1;
        }
        continue;
      }
      const liveRegion = el.closest?.('[role="status"], [role="alert"], [aria-live]');
      const inUnrelatedResult = !!el.closest?.(unrelatedResultSelector);
      if (liveRegion && !inUnrelatedResult) {
        liveCount++;
        if (isNovel(el)) liveNovelCount++;
      }
    }
    const activeDialogId = activeDialog?.getAttribute(dialogIdAttribute) || null;
    let selectedJobId = null;
    try {
      const url = new URL(window.location.href);
      selectedJobId = url.searchParams.get('currentJobId');
      if (!selectedJobId) {
        const pathMatch = url.pathname.match(/\/jobs\/view\/(?:[^/?]*-)?(\d+)\/?$/);
        if (pathMatch) selectedJobId = pathMatch[1];
      }
    } catch (_) {}
    const selectedJobMatches = !!expectedJobId && selectedJobId === expectedJobId;
    // Detail-panel evidence must come from the selected job's own status
    // block: a main-wide text search let an unrelated component (another
    // card's applied badge, a stray status module) confirm the submission.
    const detailStatusPattern = /\bApplication status\s+Application submitted\b/i;
    const main = document.querySelector('main');
    let selectedDetailSubmitted = false;
    if (selectedJobMatches && main) {
      const statusLeaves = [...main.querySelectorAll('*')].filter((el) => {
        if (!isVisible(el) || !detailStatusPattern.test(exposedText(el))) return false;
        return ![...el.children].some((child) =>
          isVisible(child) && detailStatusPattern.test(exposedText(child))
        );
      });
      selectedDetailSubmitted = statusLeaves.some((el) =>
        !el.closest('dialog') && !el.closest(unrelatedResultSelector));
    }
    const baselineOwner = baselineToken
      ? [...document.querySelectorAll(`[${ownerAttribute}]`)]
        .find((element) => element.getAttribute(ownerAttribute) === baselineToken)
      : null;
    return {
      globalCount: documentEvidence.length + shadowCount,
      dialogCounts,
      dialogNovelCounts,
      activeDialogId,
      activeDialogCount: activeDialogId ? (dialogCounts[activeDialogId] || 0) : 0,
      activeDialogNovelCount: activeDialogId ? (dialogNovelCounts[activeDialogId] || 0) : 0,
      shadowCount,
      shadowNovelCount,
      liveCount,
      liveNovelCount,
      hasShadowRoot: !!sr,
      baselineOwnerVisible: !!baselineOwner && isVisible(baselineOwner),
      expectedJobId,
      selectedJobId,
      selectedJobMatches,
      selectedDetailSubmitted,
      baselineToken: markBaseline ? baselineToken : null,
      baselineSignatures: markBaseline ? capturedSignatures : baselineSignatures,
    };
  }, { markBaseline, baselineToken, baselineSignatures, expectedJobId }).catch(() => ({
    globalCount: 0,
    dialogCounts: {},
    dialogNovelCounts: {},
    activeDialogId: null,
    activeDialogCount: 0,
    activeDialogNovelCount: 0,
    shadowCount: 0,
    shadowNovelCount: 0,
    liveCount: 0,
    liveNovelCount: 0,
    hasShadowRoot: false,
    baselineOwnerVisible: false,
    expectedJobId,
    selectedJobId: null,
    selectedJobMatches: false,
    selectedDetailSubmitted: false,
    baselineToken: markBaseline ? baselineToken : null,
    baselineSignatures: markBaseline ? [] : baselineSignatures,
  }));
}

async function firstVisibleLocator(locator) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    const actionable = await candidate.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            style.pointerEvents === 'none' || current.hidden || current.inert ||
            current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    }).catch(() => false);
    if (actionable) return candidate;
  }
  return null;
}

async function firstVisibleApplyControl(page, selector) {
  const hasActiveDialog = await markActiveApplyDialog(page);
  if (hasActiveDialog) {
    const dialog = page.locator('dialog[data-agent-active-apply="true"]').first();
    // The topmost modal owns interaction. Never reach through it to a stale
    // apply dialog just because this selector is absent from the modal.
    return firstVisibleLocator(dialog.locator(selector));
  }

  // Legacy apply UI lives only in this shadow host. A page-wide fallback can
  // click unrelated job-card controls such as Dismiss/Done/Not now.
  return firstVisibleLocator(page.locator(`#interop-outlet ${selector}`));
}

async function firstVisibleApplyButton(page, name, exact = true, allowGlobal = false) {
  const hasActiveDialog = await markActiveApplyDialog(page);
  if (hasActiveDialog) {
    const dialog = page.locator('dialog[data-agent-active-apply="true"]').first();
    // Only the topmost visible dialog is actionable. Falling through to an
    // older dialog can click the apply form behind a confirmation modal.
    return firstVisibleLocator(dialog.getByRole('button', { name, exact }));
  }

  const shadowButton = await firstVisibleLocator(
    page.locator('#interop-outlet').getByRole('button', { name, exact })
  );
  if (shadowButton) return shadowButton;
  // Generic global "Next"/"Continue" controls include results pagination.
  // Limit top-level fallback to the distinctive aria/accessibility names.
  if (!allowGlobal) return null;
  return firstVisibleLocator(page.getByRole('button', { name, exact }));
}

async function dismissActiveApplyUi(page) {
  const token = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await markActiveApplyDialog(page);
  const baseline = await page.evaluate((cleanupToken) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current instanceof Element;) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
        current = current.parentElement || current.getRootNode()?.host || null;
      }
      return true;
    };
    for (const dialog of document.querySelectorAll('dialog')) {
      if (isVisible(dialog)) dialog.setAttribute('data-agent-cleanup-existing', cleanupToken);
    }
    const active = document.querySelector('dialog[data-agent-active-apply="true"]');
    if (active) active.setAttribute('data-agent-cleanup-root', cleanupToken);
    return { hadDialog: !!active };
  }, token).catch(() => ({ hadDialog: false }));

  try {
    // Recovery can begin with the discard confirmation already active.
    const alreadyOpenDiscard = await firstVisibleApplyControl(page, 'button:has-text("Discard")');
    if (alreadyOpenDiscard) {
      await alreadyOpenDiscard.evaluate((element) => element.click());
      await sleep(500, 1000);
      return true;
    }

    const dismissBtn = await firstVisibleApplyControl(page, 'button[aria-label="Dismiss"]');
    if (!dismissBtn) return false;
    await dismissBtn.evaluate((element) => element.click());
    await sleep(500, 1000);

    await markActiveApplyDialog(page);
    const safeDialogTransition = await page.evaluate((cleanupToken) => {
      const active = document.querySelector('dialog[data-agent-active-apply="true"]');
      if (!active) return false;
      return active.getAttribute('data-agent-cleanup-root') === cleanupToken ||
        active.getAttribute('data-agent-cleanup-existing') !== cleanupToken;
    }, token).catch(() => false);

    let discardBtn = null;
    if (safeDialogTransition) {
      const active = page.locator('dialog[data-agent-active-apply="true"]').first();
      discardBtn = await firstVisibleLocator(active.locator('button:has-text("Discard")'));
    } else if (!baseline.hadDialog) {
      // Legacy shadow flow: the same host may transition to its discard view.
      discardBtn = await firstVisibleLocator(
        page.locator('#interop-outlet button:has-text("Discard")')
      );
    }
    if (!discardBtn) return true;
    await discardBtn.evaluate((element) => element.click());
    await sleep(500, 1000);
    return true;
  } finally {
    await page.evaluate((cleanupToken) => {
      for (const dialog of document.querySelectorAll(
        '[data-agent-cleanup-existing], [data-agent-cleanup-root]'
      )) {
        if (dialog.getAttribute('data-agent-cleanup-existing') === cleanupToken) {
          dialog.removeAttribute('data-agent-cleanup-existing');
        }
        if (dialog.getAttribute('data-agent-cleanup-root') === cleanupToken) {
          dialog.removeAttribute('data-agent-cleanup-root');
        }
      }
    }, token).catch(() => {});
  }
}

async function classifyApplyBlockage(page, config) {
  const topChoicePolicy = config.platformPolicy?.linkedin?.topChoice || 'never';
  if (topChoicePolicy !== 'always' && await detectTopChoiceBlocked(page)) {
    return 'top_choice_required';
  }
  return 'retry_failed';
}

async function handleInlineApplyStep(page, defaultAnswers, config, logger, jobId, dryRun, stepNum, options = {}) {
  await sleep(800, 1500);

  // Per-step guard-refusal tracking: only the refusals on the step that
  // ultimately blocks matter for classifying an abandonment.
  if (options.guardBlockedLabels) options.guardBlockedLabels.clear();

  // The August dialog and the legacy shadow form can coexist because LinkedIn
  // retains old templates. Select one active root before filling so stale
  // shadow controls cannot be mutated or audited alongside the dialog.
  const hasDialogScope = await markActiveApplyDialog(page);
  const shadowFill = hasDialogScope
    ? EMPTY_SHADOW_RESULT()
    : await fillShadowForm(page, defaultAnswers, logger, jobId, {
      config,
      runId: options.runId || null,
    }).catch(() => EMPTY_SHADOW_RESULT());
  const configuredTopChoicePolicy = config.platformPolicy?.linkedin?.topChoice || 'never';
  if (shadowFill.topChoice?.policyBlocked) {
    logger.warn({ platform: 'linkedin', jobId, stepNum }, 'Could not enforce LinkedIn Top Choice policy in shadow form');
    return configuredTopChoicePolicy === 'always' ? 'retry_failed' : 'top_choice_required';
  }
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
  const scopedFillOptions = hasDialogScope
    ? { ...options, scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    : options;
  try {
    await fillForm(page, defaultAnswers, config, logger, 'linkedin', jobId, scopedFillOptions);
  } catch (error) {
    if (error?.code === 'TOP_CHOICE_POLICY_VIOLATION') {
      logger.warn({ platform: 'linkedin', jobId, stepNum }, 'Could not enforce LinkedIn Top Choice policy in dialog form');
      return configuredTopChoicePolicy === 'always' ? 'retry_failed' : 'top_choice_required';
    }
    logger.warn({
      platform: 'linkedin', jobId, stepNum, error: error?.message || String(error),
    }, 'LinkedIn dialog form fill failed; refusing to advance or submit');
    return 'retry_failed';
  }

  // ── Custom radio-group questions (2026-08 dialog UI) ──
  // Invisible native inputs make these unreachable for fillForm.
  try {
    await fillDialogRadioGroups(page, defaultAnswers, config, logger, jobId, options);
  } catch (_) {}

  await sleep(500, 1000);

  // ── Find and click the action button ──
  // Playwright's locator() pierces shadow DOM automatically.
  // 2026-08-13 redesign: the apply flow moved out of the interop shadow into
  // a page-level <dialog> whose action buttons carry NO aria-label — just
  // text ("Next", "Review", "Submit application"). The results pagination
  // also has a "Next" button, so text matches MUST be dialog-scoped.
  // Plain 'dialog' scope, deliberately NOT 'dialog:visible': the :visible
  // variant made every flow stall on Next in the 2026-08-21 dry-run (clicks
  // resolved against a different node than the working plain-scoped locator),
  // while buttonSpecs' own isVisible() check already rejects hidden matches.
  const buttonSpecs = [
    { name: 'Submit application', action: 'submit', allowGlobal: true },
    { name: 'Submit', action: 'submit' },
    { name: 'Review your application', action: 'next', allowGlobal: true },
    { name: 'Continue to next step', action: 'next', allowGlobal: true },
    { name: 'Review', action: 'next' },
    { name: 'Next', action: 'next' },
    { name: 'Continue', action: 'next' },
    // Legacy shadow buttons sometimes append step/progress text to the name.
    // Anchor the prefix so "Review" cannot match an unrelated "Preview".
    { name: /^Next(?:\s+(?:step\s+)?\d+\s*(?:\/|of)\s*\d+(?:\s*pages?)?)?$/i, action: 'next' },
    { name: /^Review(?: your)? application(?:\s+\d+\s*(?:\/|of)\s*\d+\s*pages?)?$/i, action: 'next' },
    { name: /^Continue(?:\s+(?:to\s+)?(?:step\s+)?\d+\s*(?:\/|of)\s*\d+(?:\s*pages?)?)?$/i, action: 'next' },
  ];

  let btn = null;
  let btnAction = null;
  for (const { name, action, exact = true, allowGlobal = false } of buttonSpecs) {
    btn = await firstVisibleApplyButton(page, name, exact, allowGlobal);
    if (btn) btnAction = action;
    if (btn) break;
  }

  if (!btn) {
    logger.warn({ jobId, stepNum }, 'Could not find Next/Submit button in apply form');
    return 'error';
  }

  const btnText = await btn.innerText().catch(() => '?');
  logger.debug({ platform: 'linkedin', jobId, btnText: btnText.trim(), action: btnAction, stepNum }, 'Clicking apply button');

  const isEnabled = await btn.isEnabled().catch(() => false);
  const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
  if (!isEnabled || ariaDisabled === 'true') {
    logger.warn({ platform: 'linkedin', jobId, stepNum, action: btnAction }, 'Apply action button is disabled; refusing to advance');
    return classifyApplyBlockage(page, config);
  }

  if (btnAction === 'submit') {
    // Controlled inputs can be asynchronously reselected after the fill pass.
    // Re-check immediately before Submit so never-spend is an invariant, not
    // merely a best-effort fill action.
    const topChoiceState = await inspectTopChoiceState(page);
    if (configuredTopChoicePolicy === 'always' && topChoiceState.present && !topChoiceState.checked) {
      logger.warn({ platform: 'linkedin', jobId, stepNum }, 'Top Choice is unchecked under always-use policy; refusing to submit');
      return 'retry_failed';
    }
    if (configuredTopChoicePolicy !== 'always' && topChoiceState.checked) {
      logger.warn({ platform: 'linkedin', jobId, stepNum }, 'Top Choice is selected under never-spend policy; refusing to submit');
      return 'top_choice_required';
    }
    if (dryRun) {
      await screenshotError(page, 'linkedin', `dryrun-${jobId}`, config);
      logger.info({ jobId }, '[DRY RUN] Would submit — taking screenshot instead');
      // Dismiss the form
      try {
        await dismissActiveApplyUi(page);
      } catch (_) {}
      return 'submitted';
    }
    const confirmationBaseline = await captureSubmissionConfirmationEvidence(page, {
      markBaseline: true,
      expectedJobId: jobId,
    });
    const clicked = await btn.evaluate((e) => {
      if (e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
      e.click();
      return true;
    }).catch(() => false);
    if (!clicked) {
      await clearSubmissionConfirmationBaseline(page, confirmationBaseline.baselineToken);
      logger.warn({ platform: 'linkedin', jobId, stepNum }, 'Submit click failed; application not submitted');
      return 'retry_failed';
    }
    const confirmed = await waitForSubmissionConfirmation(page, {
      // The current detail-panel confirmation regularly appears just after
      // the old 10-second deadline. Screenshots from 13 real submissions on
      // 2026-08-25..29 showed it 2-3 seconds after that timeout fired.
      timeout: options.submissionConfirmationTimeout ?? 20000,
      baselineEvidence: confirmationBaseline,
      expectedJobId: jobId,
    });
    if (!confirmed) {
      logger.warn({ platform: 'linkedin', jobId, stepNum }, 'Submit click was not confirmed; application not recorded as submitted');
      return 'submit_unconfirmed';
    }
    return 'submitted';
  }

  // action === 'next' — click via JS to bypass interop-outlet overlay
  await btn.evaluate(e => e.click());
  await sleep(1000, 1500);

  // Check for validation errors in both the legacy shadow root and the
  // page-level dialog introduced by LinkedIn's 2026-08 redesign.
  const postClickErrors = await collectApplyValidationErrors(page);

  if (postClickErrors.length > 0) {
    // ── Structured diagnostics for validation failures ──
    await markActiveApplyDialog(page);
    const fieldDiag = await page.evaluate(() => {
      const roots = [];
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          !el.hidden && el.getAttribute('aria-hidden') !== 'true';
      };
      const activeDialog = document.querySelector('dialog[data-agent-active-apply="true"]');
      const interop = document.querySelector('#interop-outlet');
      if (activeDialog) roots.push({ root: activeDialog, inShadow: false });
      else if (interop && interop.shadowRoot) roots.push({ root: interop.shadowRoot, inShadow: true });
      const fields = [];
      for (const { root: sr, inShadow } of roots) {
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
          inShadow,
        });
      }
      // Also check radio groups — fieldset first: closest('fieldset, div, li')
      // returns the option's own wrapper div and degrades the label to "Yes"
      for (const radio of sr.querySelectorAll('input[type="radio"]')) {
        const parent = radio.closest('fieldset') || radio.closest('div, li');
        const legend = parent?.querySelector('legend') || parent?.querySelector('label');
        const groupLabel = legend ? legend.textContent.trim().substring(0, 80) : '';
        if (groupLabel && !fields.some(f => f.label === groupLabel)) {
          fields.push({ tag: 'INPUT', type: 'radio', label: groupLabel, hasValue: radio.checked, valueLen: 0, hasError: false, inShadow });
        }
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

    const retryHasDialogScope = await markActiveApplyDialog(page);
    const retryOptions = retryHasDialogScope
      ? { ...options, scopeSelector: 'dialog[data-agent-active-apply="true"]' }
      : options;
    let retry;
    try {
      retry = await retryInvalidFields(page, defaultAnswers, config, logger, 'linkedin', jobId, retryOptions);
    } catch (error) {
      if (error?.code === 'TOP_CHOICE_POLICY_VIOLATION') {
        return configuredTopChoicePolicy === 'always' ? 'retry_failed' : 'top_choice_required';
      }
      retry = { retryFilled: 0 };
    }
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
        return classifyApplyBlockage(page, config);
      }
      return 'next';
    }
    return classifyApplyBlockage(page, config);
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
  let noResultsPageOne = false;
  const RELOAD_EVERY_CARDS = config.behavior?.linkedinReloadEveryCards || 5;
  // Within-run dedup of the result carousel. LinkedIn re-serves the same
  // promoted block after every reload, and a reload restarts the card loop
  // from index 0 — without these sets, five consecutive post-click skips
  // livelock the whole run re-recording the same cards (2,277 duplicate
  // skip rows in the 2026-08-28 nightly run).
  const seenRunCardKeys = new Set();
  const seenRunJobIds = new Set();

  while (applied < maxApplications && currentPage <= maxPages) {
    // ── List result cards on current page (top-level page) ──
    let cards;
    try {
      cards = await listResultCards(page);
    } catch (_) {
      logger.warn({ platform: 'linkedin', page: currentPage }, 'Could not find result cards — may have reached end');
      if (currentPage === 1) noResultsPageOne = true;
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
      if (currentPage === 1) noResultsPageOne = true;
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
        // Restart scanning the re-listed cards. seenRunCardKeys makes cards
        // that were already handled this run free (no click, no DB row), so
        // restarting cannot livelock the loop.
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

        // Within-run card dedup: the carousel re-serves the same promoted
        // cards after reloads and across pages. First encounter decides and
        // records the outcome; repeats are free.
        const cardKey = [jobTitle, company, summary.location || ''].join('|').toLowerCase();
        if (seenRunCardKeys.has(cardKey)) {
          internalSkipped++;
          continue;
        }
        seenRunCardKeys.add(cardKey);

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

        // Within-run jobId dedup for cards whose text differed between
        // encounters (card badges/insight lines rotate between renders).
        if (seenRunJobIds.has(jobId)) {
          internalSkipped++;
          continue;
        }
        seenRunJobIds.add(jobId);

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
        // hasEasyApply covers the 2026-08-13 button variant (no href).
        if (!detail.easyApplyHref && !detail.hasEasyApply) {
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

          await markActiveApplyDialog(page);
          let fingerprint = await captureApplyStepFingerprint(page);

          if (fingerprint && seenFingerprints.has(fingerprint)) {
            // The renderer may not have painted the next step yet: production
            // sessions declared a cycle ~1.3s after a Next click. Allow one
            // settle window and re-fingerprint before treating the repeat as
            // a real cycle.
            await sleep(2000, 3000);
            await markActiveApplyDialog(page);
            fingerprint = await captureApplyStepFingerprint(page);
          }

          if (fingerprint && seenFingerprints.has(fingerprint)) {
            // Surface the actual unfilled labels — pre-fix the throw gave us
            // no signal about which fields the agent couldn't resolve.
            const labels = fingerprint.split('||').filter(Boolean).slice(0, 12);

            // Attribute the cycle: an unchecked Top Choice box under policy
            // 'never' means the form is blocked by boost consent, not by an
            // unanswerable question (spec R14 — user decides, see spec
            // open question 4).
            const topChoicePolicy = config.platformPolicy?.linkedin?.topChoice || 'never';
            const topChoiceBlocked = topChoicePolicy !== 'always' && await detectTopChoiceBlocked(page);

            logger.warn({
              jobId, jobTitle, company,
              stepNum: stepCount,
              unfilledLabels: labels,
              topChoicePolicy,
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

          if (result === 'retry_failed' || result === 'top_choice_required' || result === 'submit_unconfirmed') {
            // 'submit_unconfirmed' gets its own message: the 2026-08-25..29
            // runs recorded 13 real submissions as "Validation errors" because
            // an unconfirmed submit was indistinguishable from a form bounce.
            const valErr = new Error(result === 'top_choice_required'
              ? 'top_choice_required_review — form blocked on boost checkbox, policy is never-spend'
              : result === 'submit_unconfirmed'
                ? `Submit clicked on step ${stepCount} but no confirmation observed — outcome unverified`
                : `Validation errors on step ${stepCount} — retry failed`);
            // An unconfirmed submit is an unknown outcome and must surface as
            // an error: guard metadata would downgrade it to a routine skip
            // and hide it from run health and forensics.
            if (result !== 'submit_unconfirmed' && fillOptions.guardBlockedLabels.size > 0) {
              valErr.guardedAbandonment = [...fillOptions.guardBlockedLabels];
            } else if (result === 'top_choice_required') {
              valErr.policyAbandonment = 'top_choice_required';
            }
            throw valErr;
          } else if (result === 'submitted') {
            applyComplete = true;

            logger.info({ jobId, jobTitle, company, steps: stepCount }, 'Application submitted');
            recordOutcome({ status: dryRun ? 'dry_run' : 'submitted', jobId, jobTitle, company, jobUrl, steps: stepCount, source });

            // Dismiss post-submit UI
            await sleep(1000, 2000);
            for (const sel of ['button[aria-label="Dismiss"]', 'button:has-text("Done")', 'button:has-text("Not now")']) {
              try {
                const loc = await firstVisibleApplyControl(page, sel);
                if (loc) {
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
          await dismissActiveApplyUi(page);
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

  // aborted/noResults let the orchestrator distinguish an incomplete scan
  // (reload failure, empty page 1 = challenge/DOM break/login bounce) from a
  // genuinely exhausted healthy run.
  return { applied, skipped, errors, alreadyApplied, internalSkipped, aborted: abortPlatformRun, noResults: noResultsPageOne };
}

module.exports = {
  applyLinkedIn,
  // Exported for testing
  buildLinkedInSearchUrl,
  summarizeResultCard,
  shouldApply,
  isRemoteLocation,
  fillShadowForm,
  fillDialogRadioGroups,
  handleInlineApplyStep,
  collectApplyValidationErrors,
  detectTopChoiceBlocked,
  markActiveApplyDialog,
  mapEducationAnswerToYesNo,
  matchDialogRadioOption,
  waitForSubmissionConfirmation,
  captureSubmissionConfirmationEvidence,
  firstVisibleLocator,
  firstVisibleApplyControl,
  dismissActiveApplyUi,
  hasLinkedInDailySubmissionLimitMessage,
  normalizeVisibleText,
  analyzeSearchPageState,
  pickCardStrategy,
  isJobCardText,
  APPLY_LINK_ARIA_LABELS,
  buildApplyLinkSelector,
};
