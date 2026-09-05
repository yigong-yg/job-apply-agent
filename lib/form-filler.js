'use strict';

const stringSimilarity = require('string-similarity');
const { sleep } = require('./humanize');
const { generateAnswer, FALLBACK_ANSWER } = require('./llm');
const { recordFillAudit, recordUnfilledField } = require('./state');
const { guardAnswer } = require('./answer-policy');
const { validateAnswer } = require('./output-validator');

const FUZZY_THRESHOLD = 0.6;

async function queryAllInScope(page, selector, options = {}) {
  if (!options.scopeSelector) return page.$$(selector);
  const roots = await page.$$(options.scopeSelector);
  const elements = [];
  for (const root of roots) elements.push(...await root.$$(selector));
  return elements;
}

async function isEffectivelyVisible(element) {
  return element.evaluate((el) => {
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
  }).catch(() => false);
}

/**
 * CSS.escape polyfill for Node.js context (CSS.escape only exists in browsers).
 * Escapes characters that have special meaning in CSS selectors.
 */
function cssEscape(str) {
  return String(str).replace(/([^\w-])/g, '\\$1');
}

// ─────────────────────────────────────────────────────────────────────
// Polarity keyword lists for yes/no inference (Tier 2 fallback)
// ─────────────────────────────────────────────────────────────────────
// Willingness/authorization phrasings only. 'experience with' and 'able to
// work' are FACT claims, not willingness — polarity Yes fabricated "3+ years
// LangChain/RAG" skills and office-presence availability in production.
const POSITIVE_PATTERNS = [
  'authorized to work', 'willing to relocate', 'able to commute',
  'over 18', 'legally authorized', 'comfortable with',
  'legally eligible', 'willing to travel',
];
const NEGATIVE_PATTERNS = [
  'convicted', 'felony', 'terminated', 'fired', 'disciplinary',
  'criminal', 'arrested', 'non-compete', 'non compete', 'non-solicit',
  'non solicit', 'currently an employee at', 'currently employed at',
  'ever been employed by', 'ever worked for', 'previously employed',
  'former employee',
];

/**
 * Normalize a label string for fuzzy matching:
 * - lowercase
 * - strip punctuation
 * - trim whitespace
 * - collapse multiple spaces
 */
function normalizeLabel(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWholePhrase(normalLabel, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i').test(normalLabel);
}

/**
 * Find the best matching answer from defaultAnswers for a given label.
 * Uses string-similarity for fuzzy matching with a configurable threshold.
 *
 * @param {string} label - the normalized field label
 * @param {object} defaultAnswers - key/value map from defaultAnswers.json
 * @returns {string|null} - the matched answer, or null if no match
 */
function findAnswer(label, defaultAnswers) {
  const keys = Object.keys(defaultAnswers);
  if (keys.length === 0) return null;

  const { bestMatch } = stringSimilarity.findBestMatch(label, keys);
  if (bestMatch.rating >= FUZZY_THRESHOLD) {
    return defaultAnswers[bestMatch.target];
  }

  // Also try a configured key contained in the more-specific field label.
  // The reverse direction is unsafe for short fields: label "State" matched
  // a question key containing "United States" and submitted its Yes answer.
  for (const key of keys) {
    if (label.includes(key)) {
      return defaultAnswers[key];
    }
  }

  return null;
}

/**
 * Tier 2: Rule-based inference using config-backed data and polarity patterns.
 *
 * Returns { answer, rule } if matched, or null if no rule applies.
 * Compliance/legal questions with ambiguous wording are never auto-answered.
 *
 * @param {string} normalLabel - normalized field label
 * @param {string} rawLabel - original field label
 * @param {string} fieldType - 'text', 'select', 'radio', etc.
 * @param {object} config - full config.json with user profile
 * @returns {{ answer: string, rule: string }|null}
 */
// Residency-fact phrasings of commute questions: these ask where the user
// LIVES, not whether they are willing to commute. Submitted examples of the
// blanket Yes: "confirm you currently reside within a commutable distance to
// Brea, CA", "do you currently live within a commutable distance to
// Calabasas?" — both false for the user's real location.
const RESIDENCY_FACT_RE = /\b(?:do you|currently|presently)\s+(?:live|reside)\b|\b(?:liv(?:e|ing)|resid(?:e|ing)|located?)\s+within\b|commutable distance|commuting distance/;

function inferByRules(normalLabel, rawLabel, fieldType, config) {
  const user = config.user || {};
  const rawLabelLower = String(rawLabel || '').toLowerCase();

  // Config-backed rules (highest confidence — answer from user's own data)
  const rules = [
    { rule: 'preferred_first_name', test: () => normalLabel === 'preferred first name', answer: user.firstName },
    { rule: 'preferred_last_name', test: () => normalLabel === 'preferred last name', answer: user.lastName },
    { rule: 'preferred_name', test: () => normalLabel === 'preferred name', answer: user.preferredName || user.firstName },
    { rule: 'first_name', test: () => normalLabel === 'first name' || normalLabel === 'legal first name' || normalLabel === 'given name', answer: user.firstName },
    { rule: 'middle_name', test: () => normalLabel === 'middle name' || normalLabel === 'middle initial', answer: user.middleName || 'N/A' },
    { rule: 'last_name', test: () => normalLabel === 'last name' || normalLabel === 'legal last name' || normalLabel === 'family name' || normalLabel === 'surname', answer: user.lastName },
    { rule: 'years_experience', test: () => normalLabel.includes('years') && normalLabel.includes('experience'), answer: user.yearsOfExperience },
    { rule: 'preferred_name', test: () => normalLabel.includes('preferred name'), answer: user.firstName },
    // commute must precede city_location: commute questions mention "location"
    // and would otherwise be answered with the user's city.
    // Willingness only — residency FACTS ("do you currently live within a
    // commutable distance of Calabasas?") must not get a blanket Yes; they
    // fall through to the LLM, which answers from the user's real location.
    { rule: 'commute', test: () => normalLabel.includes('commut') && !RESIDENCY_FACT_RE.test(normalLabel), answer: 'Yes' },
    { rule: 'city_location', test: () => (normalLabel.includes('city') || (normalLabel.includes('location') && !normalLabel.includes('relocation') && !normalLabel.includes('relocate') && !normalLabel.includes('commut'))), answer: user.city },
    { rule: 'state_province', test: () => normalLabel.includes('state') || normalLabel.includes('province'), answer: user.state },
    { rule: 'zip_code', test: () => normalLabel.includes('zip') || normalLabel.includes('postal'), answer: user.zipCode },
    { rule: 'salary', test: () => normalLabel.includes('salary') || normalLabel.includes('compensation') || normalLabel.includes('pay rate') || normalLabel.includes('desired pay') || normalLabel.includes('pay expectation') || normalLabel.includes('base pay'), answer: user.desiredSalary },
    // graduation_year and percentage rules removed (spec R8/R10): both invented
    // facts. Graduation year answers only from config.user.graduationYear via
    // the answer-policy guard; percentages have no honest default.
    { rule: 'start_date', test: () => normalLabel.includes('start date') || normalLabel.includes('when can you start') || normalLabel.includes('earliest start'), answer: user.startDate },
    { rule: 'email_field', test: () => normalLabel.includes('email') && fieldType === 'text', answer: user.email },
    { rule: 'phone_field', test: () => normalLabel.includes('phone') && fieldType === 'text', answer: user.phone },
    { rule: 'linkedin_url', test: () => normalLabel.includes('linkedin'), answer: user.linkedinUrl },
    { rule: 'github_url', test: () => normalLabel.includes('github'), answer: user.githubUrl || user.github },
    { rule: 'website_url', test: () => normalLabel === 'website' || normalLabel.includes('portfolio') || normalLabel.includes('personal website'), answer: user.website || user.portfolioUrl },
    // No 'N/A' fallback: submitting "N/A" as current employer is false for an
    // employed user. Rule no-ops unless config supplies the value.
    { rule: 'current_employer', test: () => normalLabel.includes('current employer') || normalLabel.includes('most recent employer'), answer: user.currentEmployer },
    { rule: 'work_auth', test: () => normalLabel.includes('authorized') || normalLabel.includes('authorization'), answer: user.workAuthorization },
    { rule: 'sponsorship', test: () => normalLabel.includes('sponsor'), answer: user.requiresSponsorship ? 'Yes' : 'No' },
    { rule: 'veteran', test: () => normalLabel.includes('veteran'), answer: user.veteranStatus },
    { rule: 'disability', test: () => normalLabel.includes('disability'), answer: user.disabilityStatus },
    { rule: 'gender', test: () => normalLabel.includes('gender'), answer: user.gender },
    { rule: 'race_ethnicity', test: () => normalLabel.includes('race') || normalLabel.includes('ethnicity'), answer: user.race },
    // gpa rule removed: '3.8' was a hardcoded invention. GPA answers only
    // from the user's own defaultAnswers via the education_facts guard class.
    { rule: 'hear_about', test: () => normalLabel.includes('hear about') || hasWholePhrase(normalLabel, 'referred') || hasWholePhrase(normalLabel, 'referral'), answer: 'Job Board' },
  ];

  for (const { rule, test, answer } of rules) {
    if (answer && test()) {
      return { answer: String(answer), rule: `rule:${rule}` };
    }
  }

  // Polarity yes/no — fallback only after config-backed rules fail
  if (fieldType === 'radio' || fieldType === 'select' || fieldType === 'text') {
    for (const pattern of POSITIVE_PATTERNS) {
      if (normalLabel.includes(pattern)) {
        return { answer: 'Yes', rule: 'rule:polarity_yes' };
      }
    }
    for (const pattern of NEGATIVE_PATTERNS) {
      if (normalLabel.includes(pattern)) {
        return { answer: 'No', rule: 'rule:polarity_no' };
      }
    }
  }

  return null;
}

/**
 * Extract the label text associated with a form element.
 * Tries multiple strategies in order of reliability.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').ElementHandle} element
 * @returns {Promise<string>}
 */
async function extractLabel(page, element) {
  try {
    // Resolve from the element itself, not page.$(). LinkedIn keeps hidden
    // form-page templates in the DOM and reuses ids between them. A global
    // `label[for=id]` / `#aria-labelledby` lookup therefore finds the stale
    // hidden node before the visible label belonging to this ElementHandle.
    const labelText = await element.evaluate((el) => {
      const cleanText = (node) => String(node?.innerText || node?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

      const isRendered = (node) => {
        if (!(node instanceof Element) || !node.isConnected) return false;
        for (let cur = node; cur instanceof Element;) {
          const style = getComputedStyle(cur);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
              Number(style.opacity) === 0 || cur.hidden || cur.inert ||
              cur.getAttribute('aria-hidden') === 'true') {
            return false;
          }
          cur = cur.parentElement || cur.getRootNode()?.host || null;
        }
        if (node.getClientRects().length > 0) return true;
        // `display: contents` labels have no box of their own, but their text
        // can still be rendered and provide the accessible name.
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getClientRects().length > 0;
        } catch (_) {
          return false;
        }
      };

      const treeParent = (node) => node?.parentNode || node?.host || null;
      const treeDistance = (a, b) => {
        const fromA = new Map();
        let cur = a;
        let distance = 0;
        while (cur) {
          fromA.set(cur, distance++);
          cur = treeParent(cur);
        }
        cur = b;
        distance = 0;
        while (cur) {
          if (fromA.has(cur)) return fromA.get(cur) + distance;
          distance++;
          cur = treeParent(cur);
        }
        return Number.MAX_SAFE_INTEGER;
      };

      const pickClosest = (nodes, requireRendered) => {
        const candidates = [...nodes].filter((node) => cleanText(node));
        const rendered = candidates.filter(isRendered);
        const pool = rendered.length > 0 ? rendered : (requireRendered ? [] : candidates);
        pool.sort((a, b) => treeDistance(el, a) - treeDistance(el, b));
        return pool[0] || null;
      };

      const root = el.getRootNode();
      const dialog = el.closest('dialog');
      const form = el.closest('form');
      // A visible field inside a dialog must resolve against that dialog
      // first. The root is only a fallback for a visible external reference.
      const localScope = dialog || form || root;
      const rootFallback = localScope !== root ? root : null;
      const mustBeRendered = !!dialog;

      const resolveInScope = (selector, predicate = () => true) => {
        const local = pickClosest(
          [...localScope.querySelectorAll(selector)].filter(predicate),
          mustBeRendered
        );
        if (local) return local;
        if (!rootFallback) return null;
        // Never fall back from an active dialog to a hidden stale template.
        return pickClosest(
          [...rootFallback.querySelectorAll(selector)].filter(predicate),
          true
        );
      };

      // Strategy 1a: an input wrapped by a label is unambiguous.
      const wrappingLabel = el.closest('label');
      if (wrappingLabel && (!mustBeRendered || isRendered(wrappingLabel))) {
        const text = cleanText(wrappingLabel);
        if (text) return text;
      }

      // Strategy 1b: explicit label[for]. Filter by the literal attribute
      // instead of querySelector('#id') so duplicate/special-character ids
      // cannot redirect the association to the first document match.
      const id = el.getAttribute('id');
      if (id) {
        const explicit = resolveInScope(
          'label[for]',
          (candidate) => candidate.getAttribute('for') === id
        );
        const text = cleanText(explicit);
        if (text) return text;
      }

      // Strategy 2: aria-label belongs directly to the actual element.
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

      // Strategy 3: aria-labelledby is a whitespace-separated IDREF list.
      // Resolve every token locally and visibly, preserving token order.
      const labelledBy = String(el.getAttribute('aria-labelledby') || '').trim();
      if (labelledBy) {
        const parts = [];
        const seen = new Set();
        for (const refId of labelledBy.split(/\s+/)) {
          if (!refId || seen.has(refId)) continue;
          seen.add(refId);
          const ref = resolveInScope('[id]', (candidate) => candidate.getAttribute('id') === refId);
          const text = cleanText(ref);
          if (text) parts.push(text);
        }
        if (parts.length > 0) return parts.join(' ');
      }

      // Strategy 4: placeholder attribute.
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return placeholder.trim();

      // Strategy 5: name attribute.
      const name = el.getAttribute('name');
      if (name && name.trim()) return name.replace(/[_-]/g, ' ').trim();

      // Strategy 6: look for nearby rendered label-like text. Keep this
      // anchored to the element's ancestors so another retained form page
      // cannot supply the fallback label.
      let parent = el.parentElement;
      for (let i = 0; i < 4; i++) {
        if (!parent) break;
        const label = pickClosest(
          parent.querySelectorAll('label, [class*="label"], [class*="Label"]'),
          mustBeRendered
        );
        if (label && label !== el) {
          const text = cleanText(label);
          if (text) return text;
        }
        const ownText = Array.from(parent.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => String(n.textContent || '').trim())
          .join(' ')
          .trim();
        if (ownText) return ownText;
        parent = parent.parentElement;
      }
      return '';
    });
    if (labelText && labelText.trim()) return labelText.trim();
  } catch (_) {
    // Ignore detached/cross-frame evaluate errors. Callers treat an empty
    // label as unknown and will not fabricate a field answer from it.
  }

  return '';
}

/**
 * Extract the label for a radio button group by looking at the fieldset/legend
 * or the closest group container.
 */
async function extractRadioGroupLabel(page, radioElement) {
  try {
    const text = await radioElement.evaluate((el) => {
      // Look for fieldset > legend
      let parent = el.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!parent) break;
        if (parent.tagName === 'FIELDSET') {
          const legend = parent.querySelector('legend');
          if (legend) return legend.textContent.trim();
        }
        // Look for a question/label container
        const questionEl = parent.querySelector('[class*="question"], [class*="Question"], legend');
        if (questionEl && !questionEl.contains(el)) {
          return questionEl.textContent.trim();
        }
        parent = parent.parentElement;
      }
      // Fallback: look at preceding sibling text
      const prev = el.previousElementSibling;
      if (prev) return prev.textContent.trim();
      return '';
    });
    return text || '';
  } catch (_) {
    return '';
  }
}

/**
 * Fill a native <select> element with timeout protection.
 *
 * LinkedIn's <select> elements sometimes don't respond to Playwright's
 * selectOption() (React intercepts the DOM).  We try three strategies:
 * 1. selectOption({ index }) with a 3-second timeout
 * 2. page.evaluate() to force-set the value + dispatch change event
 * 3. Click-based: open the dropdown, find and click the matching option
 *
 * @returns {Promise<boolean>} true if selection succeeded
 */
async function fillSelect(selectEl, matchedIndex, matchedText, page) {
  // Strategy 1: native selectOption with timeout
  let timeoutId;
  try {
    await Promise.race([
      selectEl.selectOption({ index: matchedIndex }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('timeout')), 3000);
      }),
    ]);
    return true;
  } catch (_) {
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  // Strategy 2: force-set via evaluate
  try {
    const changed = await selectEl.evaluate((el, idx) => {
      if (idx >= 0 && idx < el.options.length) {
        el.selectedIndex = idx;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    }, matchedIndex);
    if (changed) return true;
  } catch (_) {}

  // Strategy 3: click-based
  try {
    await selectEl.click();
    await sleep(300, 600);
    const options = await selectEl.$$('option');
    for (const opt of options) {
      const text = (await opt.innerText()).trim();
      if (text.toLowerCase() === matchedText.toLowerCase()) {
        await opt.click({ force: true });
        await sleep(200, 400);
        return true;
      }
    }
  } catch (_) {}

  return false;
}

/**
 * Match a numeric answer against dropdown options that contain ranges.
 *
 * Handles patterns like:
 *   "Less than 1 year", "1-3 years", "3-5 years", "5-10 years", "10+ years"
 *   "0", "1", "2", "3", "4", "5+"
 *   "Entry (0-2)", "Mid (3-5)", "Senior (6+)"
 *
 * @param {string} numericAnswer - e.g. "3" or "3.0"
 * @param {Array<{text: string, index: number}>} options - dropdown options
 * @returns {{ text: string, index: number }|null} - best matching option
 */
function matchNumericToRange(numericAnswer, options) {
  const num = parseFloat(numericAnswer);
  if (isNaN(num)) return null;

  // Collect all candidate matches with their parsed ranges
  const candidates = [];

  for (const opt of options) {
    const t = opt.text.toLowerCase();

    // Pattern: "X-Y" or "X - Y" or "X to Y" (range)
    const rangeMatch = t.match(/(\d+)\s*[-–—to]+\s*(\d+)/);
    if (rangeMatch) {
      const lo = parseFloat(rangeMatch[1]);
      const hi = parseFloat(rangeMatch[2]);
      // Use exclusive upper bound: [lo, hi)
      // At boundaries (e.g. num=3), this picks "3-5" over "1-3"
      if (num >= lo && num < hi) {
        candidates.push({ opt, priority: 0, dist: Math.abs(num - lo) });
      }
      continue;
    }

    // Pattern: "X+" or "X or more" or "more than X" or "over X"
    const plusMatch = t.match(/(\d+)\s*\+/) || t.match(/(?:more than|over|above|greater than)\s*(\d+)/);
    if (plusMatch) {
      const threshold = parseFloat(plusMatch[1]);
      if (num >= threshold) {
        candidates.push({ opt, priority: 1, dist: Math.abs(num - threshold) });
      }
      continue;
    }

    // Pattern: "less than X" or "under X" or "fewer than X" or "< X"
    const lessMatch = t.match(/(?:less than|under|fewer than|below|<)\s*(\d+)/);
    if (lessMatch) {
      const threshold = parseFloat(lessMatch[1]);
      if (num < threshold) {
        candidates.push({ opt, priority: 1, dist: Math.abs(num - threshold) });
      }
      continue;
    }

    // Pattern: exact number match in the option text (e.g. option "3" for answer "3")
    const exactMatch = t.match(/^(\d+)$/);
    if (exactMatch && parseFloat(exactMatch[1]) === num) {
      candidates.push({ opt, priority: -1, dist: 0 }); // Highest priority
    }
  }

  if (candidates.length > 0) {
    // Sort by priority (lower = better), then by distance to lower bound
    candidates.sort((a, b) => a.priority - b.priority || a.dist - b.dist);
    return candidates[0].opt;
  }

  // Fallback: find the closest range by midpoint distance
  let bestOpt = null;
  let bestDist = Infinity;
  for (const opt of options) {
    const t = opt.text.toLowerCase();
    const rangeMatch = t.match(/(\d+)\s*[-–—to]+\s*(\d+)/);
    if (rangeMatch) {
      const lo = parseFloat(rangeMatch[1]);
      const hi = parseFloat(rangeMatch[2]);
      const mid = (lo + hi) / 2;
      const dist = Math.abs(num - mid);
      if (dist < bestDist) { bestDist = dist; bestOpt = opt; }
    }
    const plusMatch = t.match(/(\d+)\s*\+/);
    if (plusMatch) {
      const threshold = parseFloat(plusMatch[1]);
      const dist = Math.abs(num - threshold);
      if (dist < bestDist) { bestDist = dist; bestOpt = opt; }
    }
  }

  return bestOpt;
}

/**
 * Try to match a dropdown answer — first via fuzzy string match,
 * then via numeric-to-range matching if the answer is numeric.
 *
 * @param {string} answer
 * @param {Array<{text: string, value: string, index: number}>} nonPlaceholderOpts
 * @returns {{ text: string, index: number }|null}
 */
function matchDropdownOption(answer, nonPlaceholderOpts) {
  if (nonPlaceholderOpts.length === 0) return null;

  // Strategy 1: fuzzy string match
  const { bestMatch } = stringSimilarity.findBestMatch(
    answer.toLowerCase(),
    nonPlaceholderOpts.map(o => o.text.toLowerCase())
  );
  if (bestMatch.rating >= 0.4) {
    return nonPlaceholderOpts.find(o => o.text.toLowerCase() === bestMatch.target) || null;
  }

  // Strategy 2: numeric-to-range matching (for "3" → "3-5 years")
  if (/^[\d.]+$/.test(answer.trim())) {
    return matchNumericToRange(answer.trim(), nonPlaceholderOpts);
  }

  return null;
}

/**
 * Click the exact radio/checkbox ElementHandle. LinkedIn retains old form
 * templates and reuses ids, so resolving label[for=id] from the page can click
 * a different step's control. force:true bypasses an overlaying styled label
 * without re-resolving the target.
 */
async function clickInput(_page, inputEl) {
  const clicked = await inputEl.evaluate((el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    // DOM activation targets this exact node. Coordinate/force clicks can hit
    // an overlaying label whose duplicate `for` id toggles a retained field.
    el.click();
    return true;
  });
  if (!clicked) throw new Error('Input is disabled and cannot be activated');
}

function matchStrictOption(answer, options) {
  const index = matchOptionTextIndex(options.map((option) => option.text), answer);
  return index >= 0 ? options[index] : null;
}

function isTopChoiceLabel(normalLabel) {
  return /\btop choice\b/.test(normalLabel);
}

async function activateInputAndVerify(page, inputEl, expected = true) {
  await clickInput(page, inputEl);
  await sleep(100, 300);
  return (await inputEl.isChecked().catch(() => !expected)) === expected;
}

const DROPDOWN_OPTION_SELECTOR = [
  '[role="option"]',
  '[data-test-text-selectable-option__label]',
  '[role="listbox"] li',
  '.basic-typeahead__selectable',
  '[data-basic-typeahead-option]',
  '.autocomplete-suggestion',
  '.pac-item',
].join(', ');

async function captureDropdownContext(page, trigger) {
  const token = `dropdown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const relation = await trigger.evaluate((el) => ({
    id: el.id || '',
    idCount: el.id
      ? [...document.querySelectorAll('[id]')]
        .filter((candidate) => candidate.getAttribute('id') === el.id).length
      : 0,
    ownedIds: `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`
      .trim().split(/\s+/).filter(Boolean),
  }));
  await page.$$eval(DROPDOWN_OPTION_SELECTOR, (candidates, snapshotToken) => {
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
    for (const candidate of candidates) {
      candidate.setAttribute('data-agent-dropdown-snapshot', snapshotToken);
      candidate.setAttribute('data-agent-dropdown-was-visible', isVisible(candidate) ? 'true' : 'false');
    }
  }, token);
  return { token, ...relation };
}

async function collectOwnedOrOpenedOptions(page, context) {
  if (!context) return [];
  const candidates = await page.$$(DROPDOWN_OPTION_SELECTOR);
  const options = [];
  for (const option of candidates) {
    if (!await isEffectivelyVisible(option)) continue;
    const belongs = await option.evaluate((candidate, relation) => {
      const snapshotMatches = candidate.getAttribute('data-agent-dropdown-snapshot') === relation.token;
      const newlyAvailable = !snapshotMatches ||
        candidate.getAttribute('data-agent-dropdown-was-visible') === 'false';
      for (const ownedId of relation.ownedIds) {
        const owners = [...document.querySelectorAll('[id]')]
          .filter((owner) => owner.getAttribute('id') === ownedId);
        if (owners.some((owner) => owner === candidate || owner.contains(candidate)) &&
            (owners.length === 1 || newlyAvailable)) return true;
      }
      const listbox = candidate.closest('[role="listbox"]');
      if (relation.id && listbox) {
        const labelledBy = String(listbox.getAttribute('aria-labelledby') || '').split(/\s+/);
        if (labelledBy.includes(relation.id) && (relation.idCount === 1 || newlyAvailable)) return true;
      }
      // Without a unique ARIA relationship, only accept an option inserted or
      // transitioned to visible after this exact trigger/input interaction.
      return newlyAvailable;
    }, context).catch(() => false);
    if (belongs) options.push(option);
  }
  return options;
}

async function cleanupDropdownContext(page, context) {
  if (!context) return;
  await page.$$eval('[data-agent-dropdown-snapshot]', (candidates, token) => {
    for (const candidate of candidates) {
      if (candidate.getAttribute('data-agent-dropdown-snapshot') !== token) continue;
      candidate.removeAttribute('data-agent-dropdown-snapshot');
      candidate.removeAttribute('data-agent-dropdown-was-visible');
    }
  }, context.token).catch(() => {});
}

function matchOptionTextIndex(optionTexts, answer) {
  const normalizedAnswer = normalizeLabel(String(answer || ''));
  if (!normalizedAnswer) return -1;
  const normalizedOptions = optionTexts.map((text) => normalizeLabel(String(text || '')));
  const exact = normalizedOptions
    .map((text, index) => ({ text, index }))
    .filter((candidate) => candidate.text === normalizedAnswer);
  if (exact.length === 1) return exact[0].index;
  if (exact.length > 1 || normalizedAnswer.length < 3) return -1;

  const isDecline = (text) => /^(?:i )?(?:(?:do not|don t) (?:wish|want) to (?:answer|say|specify|self identify)|prefer not to (?:answer|say|specify|self identify)|decline(?: to)? (?:answer|self identify)|choose not to (?:answer|say|specify|self identify))$/
    .test(text);
  if (isDecline(normalizedAnswer)) {
    const optOuts = normalizedOptions
      .map((text, index) => ({ text, index }))
      .filter((candidate) => isDecline(candidate.text));
    return optOuts.length === 1 ? optOuts[0].index : -1;
  }

  const containsWholePhrase = (haystack, phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystack);
  };
  const candidates = normalizedOptions
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => text &&
      (containsWholePhrase(text, normalizedAnswer) || containsWholePhrase(normalizedAnswer, text)));
  return candidates.length === 1 ? candidates[0].index : -1;
}

async function enforceTopChoiceState(page, checkbox, shouldBeChecked) {
  const before = await checkbox.isChecked().catch(() => false);
  if (before !== shouldBeChecked) {
    try {
      await clickInput(page, checkbox);
      await sleep(100, 300);
    } catch (_) {}
  }
  const checked = await checkbox.isChecked().catch(() => before);
  if (checked !== shouldBeChecked) {
    const error = new Error(`Unable to enforce LinkedIn Top Choice policy (${shouldBeChecked ? 'always' : 'never'})`);
    error.code = 'TOP_CHOICE_POLICY_VIOLATION';
    error.topChoicePolicy = shouldBeChecked ? 'always' : 'never';
    throw error;
  }
  return { checked, changed: checked !== before };
}

/**
 * Type a value into an input field using humanized typing with fallback.
 * After typing, checks for autocomplete/typeahead dropdowns (common on
 * city/address/location fields) and selects the best matching option.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').ElementHandle} input
 * @param {string} value
 * @param {object} config
 */
async function typeValue(page, input, value, config) {
  if (value === '') {
    await input.fill('');
    return;
  }

  // Long answers (>180 chars): use instant fill to avoid timeouts.
  // Character-by-character typing at 50-150ms/char means a 300-char answer
  // takes 15-45 seconds, which can crash the browser tab.
  const FAST_FILL_THRESHOLD = 180;
  if (value.length > FAST_FILL_THRESHOLD) {
    await input.fill(value);
    await sleep(200, 500);
    return;
  }

  // Type via the ELEMENT HANDLE, never via a re-resolved id/name selector:
  // the 2026-08 dialog UI reuses ids/names on hidden template nodes, so
  // page.click('#id') typing landed elsewhere while the visible field stayed
  // empty — the form then refused to advance with no error rendered.
  // Force-click beats the interop overlay that intercepts pointer events.
  const typingConfig = config.behavior?.typingSpeed || {};
  const charDelay = Math.floor(((typingConfig.min || 50) + (typingConfig.max || 150)) / 2);
  const dropdownContext = await captureDropdownContext(page, input).catch(() => null);
  try {
    try {
      await input.click({ force: true });
      await sleep(100, 300);
      await input.fill('');
      await input.type(String(value), { delay: charDelay });
      await sleep(100, 300);
    } catch (_) {
      // If the direct fill also fails, propagate the error so callers do not
      // count and audit an input that remained empty.
      await input.fill(String(value));
      await sleep(100, 300);
    }

    // ── Autocomplete/typeahead dropdown handling ──
    // Many platforms (LinkedIn, Indeed) show a dropdown after typing in
    // city/address/location fields. We need to select from the dropdown
    // or the form won't accept the value.
    await handleAutocompleteDropdown(page, input, value, dropdownContext);
  } finally {
    await cleanupDropdownContext(page, dropdownContext);
  }
}

/**
 * After typing in a text field, detect and interact with autocomplete
 * dropdown suggestions if one appeared.
 *
 * Common autocomplete selectors across platforms:
 * - LinkedIn: [role="listbox"] with [role="option"], .basic-typeahead__selectable
 * - Indeed: .autocomplete-dropdown, [role="listbox"]
 * - Generic: [role="listbox"], .pac-container (Google Places), ul.suggestions
 */
async function handleAutocompleteDropdown(page, input, typedValue, dropdownContext) {
  // Wait briefly for dropdown to render (autocomplete is async)
  await sleep(400, 800);

  const visibleOptions = await collectOwnedOrOpenedOptions(page, dropdownContext);

  if (visibleOptions.length === 0) return;

  // Find the best matching option by text similarity
  const optTexts = [];
  for (const opt of visibleOptions) {
    optTexts.push((await opt.innerText().catch(() => '')).trim());
  }

  // Prefer normalized exact/whole-phrase matching. Token boundaries prevent
  // short values such as Male from matching Female.
  let bestIdx = matchOptionTextIndex(optTexts, typedValue);

  // Fuzzy match fallback
  if (bestIdx < 0 && optTexts.length > 0) {
    const { bestMatch } = stringSimilarity.findBestMatch(
      typedValue.toLowerCase(),
      optTexts.map(t => t.toLowerCase())
    );
    if (bestMatch.rating >= 0.3) {
      bestIdx = optTexts.findIndex(t => t.toLowerCase() === bestMatch.target);
    }
  }

  // Default to first option if no good match (user likely wants the top suggestion)
  if (bestIdx < 0) bestIdx = 0;

  try {
    await visibleOptions[bestIdx].click();
    await sleep(200, 400);
  } catch (_) {
    // If click fails, try pressing Enter or ArrowDown+Enter to select
    try {
      await input.press('ArrowDown');
      await sleep(100, 200);
      await input.press('Enter');
      await sleep(200, 400);
    } catch (__) {}
  }
}

/**
 * Extract the error message text associated with an invalid form field.
 * Looks for error elements near the field via aria-describedby, sibling
 * elements with error classes, or parent container error text.
 */
async function extractErrorMessage(page, element) {
  try {
    return await element.evaluate((el) => {
      // Strategy 1: aria-describedby → error element
      const describedBy = el.getAttribute('aria-describedby');
      if (describedBy) {
        const errEl = document.getElementById(describedBy);
        if (errEl) {
          const t = errEl.textContent.trim();
          if (t) return t;
        }
      }

      // Strategy 2: aria-errormessage
      const errMsgId = el.getAttribute('aria-errormessage');
      if (errMsgId) {
        const errEl = document.getElementById(errMsgId);
        if (errEl) {
          const t = errEl.textContent.trim();
          if (t) return t;
        }
      }

      // Strategy 3: sibling/nearby error elements
      let parent = el.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        const errEls = parent.querySelectorAll('[class*="error"], [class*="invalid"], [role="alert"], [class*="Error"]');
        for (const e of errEls) {
          const t = e.textContent.trim();
          if (t && t.length < 200) return t;
        }
        parent = parent.parentElement;
      }

      return '';
    });
  } catch (_) {
    return '';
  }
}

/**
 * Record a fill audit entry if runId is available.
 */
function auditFill(platform, jobId, runId, rawLabel, fieldType, inputType, fillSource, answer, confidence) {
  if (!runId) return;
  try {
    recordFillAudit({ platform, jobId, runId, fieldLabel: rawLabel, fieldType, inputType, fillSource, answer, confidence });
  } catch (_) {
    // Non-critical — don't crash the form fill
  }
}

/**
 * Tier 0: never-auto-answer guard (spec R8), shared by every field loop.
 *
 * @returns {null | {blocked: true} | {answer: string, source: string}}
 *   null      → unguarded, normal tiers proceed
 *   blocked   → guarded with no exact config fact; field must stay empty
 *               (already audited + recorded here)
 *   answer    → guarded and answered from exact config (validated)
 */
function runGuard(rawLabel, fieldType, config, answers, ctx) {
  const { platform, jobId, runId, logger, unfilledFields } = ctx;
  const guard = guardAnswer(rawLabel, { config, defaultAnswers: answers });
  if (guard.action === 'proceed') return null;

  if (guard.action === 'answer') {
    const v = validateAnswer(guard.answer, { label: rawLabel, fieldType });
    if (v.ok) return { answer: v.answer, source: guard.source };
  }

  auditFill(platform, jobId, runId, rawLabel, fieldType, null, 'cannot_fill', '', `guard:${guard.reason || 'invalid_config_answer'}`);
  unfilledFields.push({ fieldLabel: rawLabel, fieldType });
  recordUnfilledField({ platform, jobId, fieldLabel: rawLabel, fieldType });
  logger.info({ platform, jobId, field: rawLabel.substring(0, 80), questionClass: guard.questionClass, reason: guard.reason }, 'Guard blocked field (never-auto-answer)');
  return { blocked: true };
}

/**
 * Fill all detectable form fields on the current page/modal with answers
 * from defaultAnswers, using the 3-tier cascade:
 *   Tier 1: defaultAnswers fuzzy match (free, instant)
 *   Tier 2: Rule-based inference from config (free, instant)
 *   Tier 3: LLM generation (budgeted per job)
 *   Cannot-fill: schema-aware safe default or leave empty
 *
 * @param {import('playwright').Page} page
 * @param {object} defaultAnswers - from defaultAnswers.json
 * @param {object} config - full config (for resumePath, user info, etc.)
 * @param {object} logger - pino logger
 * @param {string} [platform] - platform name for logging
 * @param {string} [jobId] - job ID for logging
 * @param {object} [options] - optional extensions
 * @param {object} [options.jobContext] - { jobTitle, company, jobDescription }
 * @param {Map} [options.llmCache] - per-run LLM answer cache
 * @param {object} [options.llmBudget] - { callsRemaining, msRemaining } shared per job
 * @param {string} [options.runId] - run ID for fill_audit recording
 * @returns {Promise<{ filledCount: number, unfilledFields: Array }>}
 */
async function fillForm(page, defaultAnswers, config, logger, platform = 'unknown', jobId = null, options = {}) {
  const answers = defaultAnswers.defaultAnswers || defaultAnswers;
  const runId = options.runId || null;
  let filledCount = 0;
  const unfilledFields = [];

  // ─────────────────────────────────────────────────────────────────────
  // TEXT INPUTS & TEXTAREAS
  // ─────────────────────────────────────────────────────────────────────
  const textInputs = await queryAllInScope(page, 'input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input[type="url"], textarea', options);

  for (const input of textInputs) {
    // Skip hidden, disabled, or readonly inputs
    const isVisible = await isEffectivelyVisible(input);
    const isDisabled = await input.isDisabled();
    if (!isVisible || isDisabled) continue;

    // Skip inputs that are already filled with a non-empty value
    const currentValue = await input.inputValue().catch(() => '');
    if (currentValue.trim()) continue;

    const rawLabel = await extractLabel(page, input);
    if (!rawLabel) continue;

    const normalLabel = normalizeLabel(rawLabel);
    const inputType = await input.getAttribute('type').catch(() => 'text');
    const tagName = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => 'input');
    const guardFieldType = tagName === 'textarea' ? 'textarea' : 'text';

    // ── Tier 0: never-auto-answer guard (spec R8) ──
    const guarded = runGuard(rawLabel, guardFieldType, config, answers, { platform, jobId, runId, logger, unfilledFields });
    if (guarded) {
      if (guarded.blocked) continue;
      let guardValue = guarded.answer;
      if (inputType === 'number' && /^\d+$/.test(guardValue)) {
        guardValue = guardValue + '.0';
      }
      await typeValue(page, input, guardValue, config);
      filledCount++;
      auditFill(platform, jobId, runId, rawLabel, tagName, inputType, guarded.source, guardValue, 'guard_config');
      logger.debug({ platform, jobId, field: rawLabel, answerLength: String(guardValue).length }, 'Filled text field (Tier 0 guard config)');
      continue;
    }

    // ── Tier 1: Fuzzy match against defaultAnswers ──
    let answer = findAnswer(normalLabel, answers);

    // Format guard: reject non-numeric fuzzy matches for numeric-expecting fields.
    // Labels like "how many years of experience with Python" fuzzy-match
    // "do you have experience with python" → "Yes", which is the wrong type.
    // Detect numeric intent and reject yes/no or text answers.
    const NUMERIC_INDICATORS = ['how many', 'number of', 'years of', 'months of', 'how long', 'total years', 'scale of', 'rate ', 'rating', 'percentage', 'percent', 'graduation year', 'year of graduation'];
    const looksNumeric = inputType === 'number' || NUMERIC_INDICATORS.some(kw => normalLabel.includes(kw));
    if (answer !== null && looksNumeric && !/^[\d.]+$/.test(answer)) {
      logger.debug({ platform, jobId, field: rawLabel, rejectedLength: String(answer).length }, 'Tier 1 format guard: rejected non-numeric answer for numeric field');
      answer = null; // Fall through to Tier 2
    }

    // Output validation (spec R11): placeholders like [PORTFOLIO_URL] in the
    // answer map must never reach the DOM.
    if (answer !== null) {
      const v = validateAnswer(answer, { label: rawLabel, fieldType: guardFieldType, inputType });
      if (!v.ok) {
        logger.debug({ platform, jobId, field: rawLabel, rejectedLength: String(answer).length, reason: v.reason }, 'Tier 1 output guard rejected answer');
        answer = null; // Fall through to Tier 2
      }
    }

    if (answer !== null) {
      let fillValue = answer;
      // For number inputs, ensure decimal format for LinkedIn validation
      if (inputType === 'number' && /^\d+$/.test(fillValue)) {
        fillValue = fillValue + '.0';
      }
      await typeValue(page, input, fillValue, config);
      filledCount++;
      auditFill(platform, jobId, runId, rawLabel, tagName, inputType, 'defaultAnswers', fillValue, 'fuzzy');
      logger.debug({ platform, jobId, field: rawLabel, answerLength: String(fillValue).length }, 'Filled text field (Tier 1)');
      continue;
    }

    // ── Tier 2: Rule-based inference ──
    const ruleResult = inferByRules(normalLabel, rawLabel, 'text', config);
    if (ruleResult && validateAnswer(ruleResult.answer, { label: rawLabel, fieldType: guardFieldType, inputType }).ok) {
      let fillValue = ruleResult.answer;
      if (inputType === 'number' && /^\d+$/.test(fillValue)) {
        fillValue = fillValue + '.0';
      }
      await typeValue(page, input, fillValue, config);
      filledCount++;
      auditFill(platform, jobId, runId, rawLabel, tagName, inputType, ruleResult.rule, fillValue, 'rule');
      logger.debug({ platform, jobId, field: rawLabel, answerLength: String(fillValue).length, rule: ruleResult.rule }, 'Filled text field (Tier 2)');
      continue;
    }

    // ── Tier 3: LLM generation (budgeted) ──
    // Detect essay-like fields: textarea tag OR question-like label keywords
    const ESSAY_KEYWORDS = ['describe', 'explain', 'why', 'tell us', 'how would', 'what makes',
      'share', 'elaborate', 'summary', 'about yourself', 'cover letter', 'interest in'];
    const isEssayField = tagName === 'textarea' ||
      ESSAY_KEYWORDS.some(kw => normalLabel.includes(kw));

    const budget = options.llmBudget;
    const canUseLlm = options.llmCache && budget && budget.callsRemaining > 0;

    if (canUseLlm) {
      const mode = (isEssayField || rawLabel.length > 80) ? 'long' : 'short';
      const startMs = Date.now();
      const llmAnswer = await generateAnswer(rawLabel, options.jobContext || {}, options.llmCache, logger, mode);
      const elapsed = Date.now() - startMs;

      // Deduct from budget
      budget.callsRemaining--;
      budget.msRemaining -= elapsed;

      const llmUsable = llmAnswer && llmAnswer !== FALLBACK_ANSWER &&
        !/^cannot_answer\b/i.test(llmAnswer.trim()) &&
        validateAnswer(llmAnswer, { label: rawLabel, fieldType: guardFieldType, inputType }).ok;
      if (llmUsable) {
        await typeValue(page, input, llmAnswer, config);
        filledCount++;
        auditFill(platform, jobId, runId, rawLabel, tagName, inputType, `llm:${mode}`, llmAnswer, 'llm');
        logger.info({ platform, jobId, field: rawLabel.substring(0, 80), source: `llm:${mode}`, answerLength: llmAnswer.length }, 'Filled field via LLM (Tier 3)');
        continue;
      }
      // LLM returned fallback/CANNOT_ANSWER/invalid output — fall through to cannot-fill
    }

    // ── Cannot-fill: leave empty (spec R10 — the generic interview fallback
    // was submitted verbatim to factual questions; blank is honest) ──
    auditFill(platform, jobId, runId, rawLabel, tagName, inputType, 'cannot_fill', '', 'none');
    unfilledFields.push({ fieldLabel: rawLabel, fieldType: guardFieldType });
    recordUnfilledField({ platform, jobId, fieldLabel: rawLabel, fieldType: guardFieldType });
    logger.debug({ platform, jobId, field: rawLabel }, 'No match for text field — leaving empty (cannot_fill)');
  }

  // ─────────────────────────────────────────────────────────────────────
  // SELECT DROPDOWNS
  // ─────────────────────────────────────────────────────────────────────
  const selects = await queryAllInScope(page, 'select', options);
  const placeholderPattern = /^(|0|placeholder|select|select an option|choose|please select|-- select|--select--)$/i;

  for (const select of selects) {
    const isVisible = await isEffectivelyVisible(select);
    if (!isVisible) continue;

    // Skip if already has a non-placeholder selection.
    const selectedValue = await select.inputValue().catch(() => '');
    const selectedText = await select.evaluate(el => {
      const opt = el.options[el.selectedIndex];
      return opt ? opt.textContent.trim() : '';
    }).catch(() => '');
    if (selectedValue && !placeholderPattern.test(selectedValue) && !placeholderPattern.test(selectedText)) {
      continue;
    }

    const rawLabel = await extractLabel(page, select);
    const normalLabel = normalizeLabel(rawLabel);

    // Get all option details upfront
    const optionDetails = await select.$$eval('option', opts =>
      opts.map(o => ({ text: o.textContent.trim(), value: o.value, index: o.index }))
    );
    const optionTexts = optionDetails.map(o => o.text);

    const nonPlaceholderOpts = optionDetails.filter(o =>
      o.text && !placeholderPattern.test(o.text)
    );

    // ── Tier 0: never-auto-answer guard (spec R8) ──
    const guarded = runGuard(rawLabel, 'select', config, answers, { platform, jobId, runId, logger, unfilledFields });
    if (guarded) {
      if (guarded.blocked) continue;
      const matched = nonPlaceholderOpts.length > 0
        ? matchStrictOption(guarded.answer, nonPlaceholderOpts)
        : null;
      if (matched) {
        const ok = await fillSelect(select, matched.index, matched.text, page);
        if (ok) {
          await sleep(100, 300);
          filledCount++;
          auditFill(platform, jobId, runId, rawLabel, 'select', null, guarded.source, matched.text, 'guard_config');
          logger.debug({ platform, jobId, field: rawLabel, selected: matched.text }, 'Selected dropdown (Tier 0 guard config)');
          continue;
        }
      }
      // Configured answer matched no option — stay unselected rather than guess.
      auditFill(platform, jobId, runId, rawLabel, 'select', null, 'cannot_fill', '', 'guard:no_option_match');
      unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'select' });
      recordUnfilledField({ platform, jobId, fieldLabel: rawLabel, fieldType: 'select' });
      continue;
    }

    // ── Tier 1: Fuzzy match against defaultAnswers ──
    const answer = findAnswer(normalLabel, answers);

    if (answer !== null && nonPlaceholderOpts.length > 0) {
      const matched = matchDropdownOption(answer, nonPlaceholderOpts);
      if (matched) {
        const ok = await fillSelect(select, matched.index, matched.text, page);
        if (ok) {
          await sleep(100, 300);
          filledCount++;
          auditFill(platform, jobId, runId, rawLabel, 'select', null, 'defaultAnswers', matched.text, 'fuzzy');
          logger.debug({ platform, jobId, field: rawLabel, selected: matched.text }, 'Selected dropdown (Tier 1)');
          continue;
        }
      }
      // Fuzzy + numeric match both failed — don't continue, fall through to Tier 2
    }

    // ── Tier 2: Rule-based inference ──
    const ruleResult = inferByRules(normalLabel, rawLabel, 'select', config);
    if (ruleResult && nonPlaceholderOpts.length > 0) {
      const matched = matchDropdownOption(ruleResult.answer, nonPlaceholderOpts);
      if (matched) {
        const ok = await fillSelect(select, matched.index, matched.text, page);
        if (ok) {
          await sleep(100, 300);
          filledCount++;
          auditFill(platform, jobId, runId, rawLabel, 'select', null, ruleResult.rule, matched.text, 'rule');
          logger.debug({ platform, jobId, field: rawLabel, selected: matched.text, rule: ruleResult.rule }, 'Selected dropdown (Tier 2)');
          continue;
        }
      }
    }

    // ── Yes/no dropdown polarity check ──
    const optTextsLower = nonPlaceholderOpts.map(o => o.text.toLowerCase());
    const isYesNo = optTextsLower.some(t => t === 'yes') && optTextsLower.some(t => t === 'no');
    if (isYesNo && normalLabel) {
      // Check polarity
      let polarityAnswer = null;
      for (const pattern of POSITIVE_PATTERNS) {
        if (normalLabel.includes(pattern)) { polarityAnswer = 'Yes'; break; }
      }
      if (!polarityAnswer) {
        for (const pattern of NEGATIVE_PATTERNS) {
          if (normalLabel.includes(pattern)) { polarityAnswer = 'No'; break; }
        }
      }
      if (polarityAnswer) {
        const matched = nonPlaceholderOpts.find(o => o.text.toLowerCase() === polarityAnswer.toLowerCase());
        if (matched) {
          const ok = await fillSelect(select, matched.index, matched.text, page);
          if (ok) {
            await sleep(100, 200);
            filledCount++;
            const rule = polarityAnswer === 'Yes' ? 'rule:polarity_yes' : 'rule:polarity_no';
            auditFill(platform, jobId, runId, rawLabel, 'select', null, rule, matched.text, 'polarity');
            logger.debug({ platform, jobId, field: rawLabel, selected: matched.text }, 'Selected yes/no dropdown (polarity)');
            continue;
          }
        }
      }
    }

    // ── Safe default: first option is allowed ONLY for low-risk
    // discovery-source questions (spec R10). Picking the first option on an
    // unknown dropdown submitted "Abraham Baldwin Agricultural College" as
    // the applicant's school.
    const LOW_RISK_FIRST_OPTION = /(hear about|referral source|how did you (find|learn))/;
    if (nonPlaceholderOpts.length > 0 && LOW_RISK_FIRST_OPTION.test(normalLabel)) {
      const firstReal = nonPlaceholderOpts[0];
      const ok = await fillSelect(select, firstReal.index, firstReal.text, page);
      if (ok) {
        await sleep(100, 200);
        filledCount++;
        auditFill(platform, jobId, runId, rawLabel, 'select', null, 'safe_default', firstReal.text, 'first_option');
        if (rawLabel) unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'select' });
        logger.debug({ platform, jobId, field: rawLabel, selected: firstReal.text }, 'Selected first option (safe_default, low-risk)');
      }
    } else if (rawLabel) {
      auditFill(platform, jobId, runId, rawLabel, 'select', null, 'cannot_fill', '', 'no_safe_default');
      unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'select' });
      recordUnfilledField({ platform, jobId, fieldLabel: rawLabel, fieldType: 'select' });
      logger.debug({ platform, jobId, field: rawLabel }, 'Unknown dropdown left unselected (no safe default)');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // LINKEDIN CUSTOM DROPDOWNS (non-native <select>)
  // ─────────────────────────────────────────────────────────────────────
  const customDropdowns = await queryAllInScope(page, '[data-test-text-selectable-option] select, [role="combobox"], [aria-haspopup="listbox"], [data-test-dropdown]', options);

  for (const trigger of customDropdowns) {
    const isVisible = await isEffectivelyVisible(trigger);
    if (!isVisible) continue;

    // Skip if it looks like it already has a selection (non-placeholder text)
    const currentText = await trigger.evaluate(el => (el.textContent || el.value || '').trim());
    if (currentText && !['select an option', 'select', 'choose', 'please select', ''].includes(currentText.toLowerCase())) {
      continue;
    }

    const rawLabel = await extractLabel(page, trigger);
    const normalLabel = normalizeLabel(rawLabel);

    // ── Tier 0: never-auto-answer guard (spec R8) ──
    let answer = null;
    let answerSource = 'defaultAnswers';
    const guarded = runGuard(rawLabel, 'custom-dropdown', config, answers, { platform, jobId, runId, logger, unfilledFields });
    if (guarded) {
      if (guarded.blocked) continue;
      answer = guarded.answer;
      answerSource = guarded.source;
    }

    // Tier 1: fuzzy match
    if (!answer) answer = findAnswer(normalLabel, answers);

    // Tier 2: rule-based inference
    if (!answer) {
      const ruleResult = inferByRules(normalLabel, rawLabel, 'custom-dropdown', config);
      if (ruleResult) {
        answer = ruleResult.answer;
        answerSource = ruleResult.rule;
        // We'll audit below if we successfully select
      }
    }

    // Output validation (spec R11)
    if (answer && !validateAnswer(answer, { label: rawLabel, fieldType: 'custom-dropdown' }).ok) {
      answer = null;
    }

    if (!answer) {
      if (normalLabel) {
        unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'custom-dropdown' });
        auditFill(platform, jobId, runId, rawLabel, 'custom-dropdown', null, 'cannot_fill', '', 'none');
      }
      continue;
    }

    let dropdownContext = null;
    try {
      // Check if there's a hidden native <select> inside or nearby
      const hiddenSelect = await trigger.$('select') ||
        await trigger.evaluateHandle(el => {
          let p = el.parentElement;
          for (let i = 0; i < 4 && p; i++) {
            const s = p.querySelector('select');
            if (s) return s;
            p = p.parentElement;
          }
          return null;
        });

      const isSelectEl = hiddenSelect && await hiddenSelect.evaluate(el => el && el.tagName === 'SELECT').catch(() => false);

      if (isSelectEl) {
        const optionTexts = await hiddenSelect.$$eval('option', opts => opts.map(o => o.textContent.trim()));
        if (optionTexts.length === 0) continue;
        const matchIndex = matchOptionTextIndex(optionTexts, answer);
        const matchedText = matchIndex >= 0 ? optionTexts[matchIndex] : null;
        if (matchedText) {
          await hiddenSelect.selectOption({ label: matchedText });
          await hiddenSelect.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
          await sleep(200, 400);
          filledCount++;
          auditFill(platform, jobId, runId, rawLabel, 'custom-dropdown', null, answerSource, matchedText, 'strict');
          logger.debug({ platform, jobId, field: rawLabel, selected: matchedText }, 'Selected custom dropdown (native select)');
          continue;
        }
      }

      // No native <select> — use click-based interaction
      dropdownContext = await captureDropdownContext(page, trigger);
      await trigger.click();
      await sleep(300, 600);

      const optionDeadline = Date.now() + 3000;
      let dropdownOptions = [];
      while (dropdownOptions.length === 0 && Date.now() < optionDeadline) {
        dropdownOptions = await collectOwnedOrOpenedOptions(page, dropdownContext);
        if (dropdownOptions.length === 0) await sleep(100, 150);
      }

      if (dropdownOptions.length === 0) {
        logger.debug({ platform, jobId, field: rawLabel }, 'Custom dropdown did not open');
        continue;
      }
      const optTexts = [];
      for (const opt of dropdownOptions) optTexts.push((await opt.innerText()).trim());
      const matchIdx = matchOptionTextIndex(optTexts, answer);
      let matched = matchIdx >= 0;
      if (matched) {
        await dropdownOptions[matchIdx].click();
        await sleep(200, 400);
        filledCount++;
        auditFill(platform, jobId, runId, rawLabel, 'custom-dropdown', null, answerSource, optTexts[matchIdx], 'strict');
        logger.debug({ platform, jobId, field: rawLabel, selected: optTexts[matchIdx] }, 'Selected custom dropdown option');
      }

      // Close dropdown if it's still open
      if (!matched) {
        await page.keyboard.press('Escape');
        await sleep(100, 200);
      }
    } catch (dropdownErr) {
      logger.debug({ platform, jobId, field: rawLabel, error: dropdownErr.message }, 'Custom dropdown interaction failed');
    } finally {
      await cleanupDropdownContext(page, dropdownContext);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // RADIO BUTTONS
  // ─────────────────────────────────────────────────────────────────────
  const radios = await queryAllInScope(page, 'input[type="radio"]', options);
  const radioGroups = new Map();

  for (const radio of radios) {
    const isVisible = await isEffectivelyVisible(radio);
    if (!isVisible) continue;

    const name = await radio.getAttribute('name');
    if (!name) continue;

    if (!radioGroups.has(name)) {
      radioGroups.set(name, []);
    }
    radioGroups.get(name).push(radio);
  }

  for (const [groupName, groupRadios] of radioGroups) {
    // Skip if one is already selected
    let alreadySelected = false;
    for (const r of groupRadios) {
      if (await r.isChecked()) {
        alreadySelected = true;
        break;
      }
    }
    if (alreadySelected) continue;

    // Get the group question label
    const questionLabel = await extractRadioGroupLabel(page, groupRadios[0]);
    const normalLabel = normalizeLabel(questionLabel || groupName);

    // Collect option labels for each radio
    const radioOptions = [];
    for (const r of groupRadios) {
      const optLabel = await extractLabel(page, r);
      radioOptions.push({ radio: r, label: optLabel });
    }

    // ── Tier 0: never-auto-answer guard (spec R8) ──
    const guarded = runGuard(questionLabel || groupName, 'radio', config, answers, { platform, jobId, runId, logger, unfilledFields });
    if (guarded) {
      if (guarded.blocked) continue;
      const matchIndex = matchOptionTextIndex(radioOptions.map((option) => option.label), guarded.answer);
      const matched = matchIndex >= 0 ? radioOptions[matchIndex] : null;
      if (matched) {
        const selected = await activateInputAndVerify(page, matched.radio);
        if (selected) {
          filledCount++;
          auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, guarded.source, matched.label, 'guard_config');
          logger.debug({ platform, jobId, group: groupName, selected: matched.label }, 'Selected radio (Tier 0 guard config)');
        } else {
          auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, 'cannot_fill', '', 'guard:activation_failed');
          unfilledFields.push({ fieldLabel: questionLabel || groupName, fieldType: 'radio' });
          recordUnfilledField({ platform, jobId, fieldLabel: questionLabel || groupName, fieldType: 'radio' });
        }
      } else {
        auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, 'cannot_fill', '', 'guard:no_option_match');
        unfilledFields.push({ fieldLabel: questionLabel || groupName, fieldType: 'radio' });
        recordUnfilledField({ platform, jobId, fieldLabel: questionLabel || groupName, fieldType: 'radio' });
      }
      continue;
    }

    // ── Tier 1: Fuzzy match ──
    const answer = findAnswer(normalLabel, answers);

    if (answer !== null) {
      const { bestMatch } = stringSimilarity.findBestMatch(
        answer.toLowerCase(),
        radioOptions.map((o) => o.label.toLowerCase())
      );
      const matched = radioOptions.find((o) => o.label.toLowerCase() === bestMatch.target);
      if (matched && bestMatch.rating >= 0.4) {
        const selected = await activateInputAndVerify(page, matched.radio);
        if (selected) {
          filledCount++;
          auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, 'defaultAnswers', matched.label, 'fuzzy');
          logger.debug({ platform, jobId, group: groupName, selected: matched.label }, 'Selected radio (Tier 1)');
        } else {
          auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, 'cannot_fill', '', 'activation_failed');
          unfilledFields.push({ fieldLabel: questionLabel || groupName, fieldType: 'radio' });
          recordUnfilledField({ platform, jobId, fieldLabel: questionLabel || groupName, fieldType: 'radio' });
        }
      }
      continue;
    }

    // ── Tier 2: Rule-based inference ──
    const ruleResult = inferByRules(normalLabel, questionLabel || groupName, 'radio', config);
    if (ruleResult) {
      const { bestMatch } = stringSimilarity.findBestMatch(
        ruleResult.answer.toLowerCase(),
        radioOptions.map((o) => o.label.toLowerCase())
      );
      const matched = radioOptions.find((o) => o.label.toLowerCase() === bestMatch.target);
      if (matched && bestMatch.rating >= 0.4) {
        const selected = await activateInputAndVerify(page, matched.radio);
        if (selected) {
          filledCount++;
          auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, ruleResult.rule, matched.label, 'rule');
          logger.debug({ platform, jobId, group: groupName, selected: matched.label, rule: ruleResult.rule }, 'Selected radio (Tier 2)');
          continue;
        }
      }
    }

    // ── No safe default (spec R10): unmatched radio groups stay unselected.
    // The yes_or_first fallback answered Yes to military service, sanctions
    // residency, and non-compete questions on submitted applications.
    auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, 'cannot_fill', '', 'no_safe_default');
    if (questionLabel) {
      unfilledFields.push({ fieldLabel: questionLabel, fieldType: 'radio' });
      recordUnfilledField({ platform, jobId, fieldLabel: questionLabel, fieldType: 'radio' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // CHECKBOXES
  // ─────────────────────────────────────────────────────────────────────
  const checkboxes = await queryAllInScope(page, 'input[type="checkbox"]', options);

  for (const checkbox of checkboxes) {
    const isVisible = await isEffectivelyVisible(checkbox);
    const rawLabel = await extractLabel(page, checkbox);
    const normalLabel = normalizeLabel(rawLabel || '');
    if (!isVisible) {
      if (platform !== 'linkedin' || !isTopChoiceLabel(normalLabel)) continue;
      const hasVisibleAssociatedLabel = await checkbox.evaluate((input) => {
        const isRendered = (element) => {
          if (!(element instanceof Element)) return false;
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
        const root = input.closest('dialog') || input.getRootNode();
        const labels = input.id
          ? [...root.querySelectorAll('label[for]')]
            .filter((label) => label.getAttribute('for') === input.id)
          : [];
        const wrapping = input.closest('label');
        return labels.some(isRendered) || !!(wrapping && isRendered(wrapping));
      }).catch(() => false);
      if (!hasVisibleAssociatedLabel) continue;
    }
    const isChecked = await checkbox.isChecked();

    // LinkedIn Top Choice consumes a limited boost credit. Required must not
    // override the explicit platform policy; under the default `never` policy
    // the caller will classify the blocked form as an intentional skip.
    if (platform === 'linkedin' && isTopChoiceLabel(normalLabel)) {
      const topChoicePolicy = config.platformPolicy?.linkedin?.topChoice || 'never';
      if (topChoicePolicy === 'always') {
        const state = await enforceTopChoiceState(page, checkbox, true);
        if (state.changed) filledCount++;
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'platform_policy:top_choice', 'checked', 'policy_always');
        logger.debug({ platform, jobId, field: rawLabel }, 'Checked Top Choice checkbox by platform policy');
      } else {
        const state = await enforceTopChoiceState(page, checkbox, false);
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'platform_policy:top_choice', 'left_unchecked', `top_choice:${topChoicePolicy}`);
        logger.debug({ platform, jobId, field: rawLabel, topChoicePolicy, clearedPreselection: state.changed }, 'Left Top Choice checkbox unchecked by platform policy');
      }
      continue;
    }

    if (isChecked) continue;

    // Auto-check consent checkboxes
    const CONSENT_WORDS = ['agree', 'certify', 'confirm', 'acknowledge', 'accept', 'consent'];
    const isConsent = CONSENT_WORDS.some((word) => normalLabel.includes(word));

    if (isConsent) {
      const checked = await activateInputAndVerify(page, checkbox);
      if (checked) {
        filledCount++;
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'rule:consent_checkbox', 'checked', 'consent');
        logger.debug({ platform, jobId, field: rawLabel }, 'Checked consent checkbox');
      } else {
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'cannot_fill', '', 'activation_failed');
        unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'checkbox' });
        recordUnfilledField({ platform, jobId, fieldLabel: rawLabel, fieldType: 'checkbox' });
      }
      continue;
    }

    // Required checkbox detection: check required/aria-required checkboxes
    const isRequired = await checkbox.evaluate(el =>
      el.required || el.getAttribute('aria-required') === 'true'
    ).catch(() => false);

    if (isRequired) {
      const checked = await activateInputAndVerify(page, checkbox);
      if (checked) {
        filledCount++;
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'rule:required_checkbox', 'checked', 'required');
        logger.debug({ platform, jobId, field: rawLabel }, 'Checked required checkbox');
      } else {
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'cannot_fill', '', 'activation_failed');
        unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'checkbox' });
        recordUnfilledField({ platform, jobId, fieldLabel: rawLabel, fieldType: 'checkbox' });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // FILE UPLOADS (resume)
  // ─────────────────────────────────────────────────────────────────────
  const fileInputs = await queryAllInScope(page, 'input[type="file"]', options);

  for (const fileInput of fileInputs) {
    const isVisible = await isEffectivelyVisible(fileInput);
    if (!isVisible) continue;

    const resumePath = config.user?.resumePath || './resumes/resume.pdf';
    const fullPath = require('path').resolve(process.cwd(), resumePath);

    if (require('fs').existsSync(fullPath)) {
      await fileInput.setInputFiles(fullPath);
      await sleep(500, 1000);
      filledCount++;
      auditFill(platform, jobId, runId, 'resume_upload', 'file', 'file', 'config', fullPath, 'file');
      logger.debug({ platform, jobId, file: fullPath }, 'Uploaded resume file');
    } else {
      logger.warn({ platform, jobId, resumePath: fullPath }, 'Resume file not found — skipping file upload');
    }
  }

  return { filledCount, unfilledFields };
}

/**
 * Retry invalid fields after a validation error.
 *
 * Key differences from the initial fillForm pass:
 * 1. Fields with WRONG values are NOT skipped — they're cleared and re-filled
 * 2. Error message text near each field is extracted and passed to the LLM
 *    so it can produce a format-appropriate answer (e.g. "Enter a number")
 * 3. LLM is prioritized for fields that already had a wrong value, since the
 *    tier cascade already produced a bad answer for those
 *
 * @param {import('playwright').Page} page
 * @param {object} defaultAnswers
 * @param {object} config
 * @param {object} logger
 * @param {string} platform
 * @param {string} jobId
 * @param {object} options - same options as fillForm (llmCache, llmBudget, jobContext, runId)
 * @returns {Promise<{ retryFilled: number }>}
 */
async function retryInvalidFields(page, defaultAnswers, config, logger, platform, jobId, options = {}) {
  const answers = (defaultAnswers.defaultAnswers || defaultAnswers);
  const runId = options.runId || null;
  let retryFilled = 0;

  // Find invalid fields via multiple strategies (LinkedIn uses class-based
  // error indicators, not always native aria-invalid)
  const invalidSelectors = [
    '[aria-invalid="true"]',
    'input:invalid', 'select:invalid', 'textarea:invalid',
  ];

  const invalidEls = [];
  for (const sel of invalidSelectors) {
    const els = await queryAllInScope(page, sel, options).catch(() => []);
    for (const el of els) {
      const isVisible = await isEffectivelyVisible(el);
      if (isVisible) invalidEls.push(el);
    }
  }

  // Strategy: find input/select/textarea elements that have a visible error
  // message in a nearby sibling or parent container. LinkedIn shows error
  // text like "Enter a decimal number" in elements with error/invalid classes.
  const errorCandidates = await queryAllInScope(
    page, 'input:not([type="hidden"]), select, textarea', options
  ).catch(() => []);
  for (const el of errorCandidates) {
    const isVisible = await isEffectivelyVisible(el);
    if (!isVisible) continue;
    const hasNearbyError = await el.evaluate((field) => {
      let parent = field.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        for (const errorEl of parent.querySelectorAll('[class*="error"], [class*="invalid"], [class*="Error"], [role="alert"]')) {
          const text = (errorEl.textContent || '').trim();
          const rect = errorEl.getBoundingClientRect();
          if (text && text.length < 200 && rect.width > 0 && rect.height > 0) return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }).catch(() => false);
    if (hasNearbyError) invalidEls.push(el);
  }

  // Also check required fields that are empty
  const requiredEls = await queryAllInScope(page, '[required]:not([type="hidden"]), [aria-required="true"]:not([type="hidden"])', options).catch(() => []);
  for (const el of requiredEls) {
    const isVisible = await isEffectivelyVisible(el);
    if (!isVisible) continue;
    const val = await el.inputValue().catch(() => '');
    if (!val.trim()) invalidEls.push(el);
  }

  // Deduplicate by element handle identity (best effort via id/name)
  const seen = new Set();
  const uniqueInvalid = [];
  for (const el of invalidEls) {
    const id = await el.getAttribute('id').catch(() => '') || '';
    const name = await el.getAttribute('name').catch(() => '') || '';
    const key = id || name || Math.random().toString();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueInvalid.push(el);
    }
  }

  logger.debug({ platform, jobId, invalidCount: uniqueInvalid.length }, 'Retrying invalid fields');

  // Invalid required fields the guard refuses to answer — reported to the
  // caller so abandonment can be classified as an honest skip, not breakage.
  const guardedInvalid = [];

  for (const el of uniqueInvalid) {
    const rawLabel = await extractLabel(page, el);
    if (!rawLabel) continue;

    const normalLabel = normalizeLabel(rawLabel);
    const tagName = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => 'input');
    const inputType = await el.getAttribute('type').catch(() => 'text');

    if (platform === 'linkedin' && inputType === 'checkbox' && isTopChoiceLabel(normalLabel)) {
      const topChoicePolicy = config.platformPolicy?.linkedin?.topChoice || 'never';
      if (topChoicePolicy === 'always') {
        const state = await enforceTopChoiceState(page, el, true);
        if (state.changed) retryFilled++;
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', inputType, 'platform_policy:top_choice', 'checked', 'retry_policy_always');
      } else {
        await enforceTopChoiceState(page, el, false);
        auditFill(platform, jobId, runId, rawLabel, 'checkbox', inputType, 'platform_policy:top_choice', 'left_unchecked', `top_choice:${topChoicePolicy}`);
      }
      continue;
    }

    // Check if the field already has a value (which is WRONG — that's why it's invalid)
    const currentValue = await el.inputValue().catch(() => '');
    const hadWrongValue = currentValue.trim().length > 0;

    // Extract the error message near this field for LLM context
    const errorMessage = await extractErrorMessage(page, el);

    logger.debug({ platform, jobId, field: rawLabel, currentValue: currentValue.substring(0, 50), errorMessage: errorMessage.substring(0, 100), hadWrongValue }, 'Retry analyzing invalid field');

    let answer = null;
    let source = null;
    let guardBackedAnswer = false;

    // Never-auto-answer guard (spec R7/R8): the retry pass must not resurrect
    // answers the primary pass refused — a guarded question answers from
    // exact config or stays empty.
    const guard = guardAnswer(rawLabel, { config, defaultAnswers: answers });
    if (guard.action === 'block') {
      logger.debug({ platform, jobId, field: rawLabel, questionClass: guard.questionClass }, 'Retry skipped guarded field');
      auditFill(platform, jobId, runId, rawLabel, tagName, inputType, 'cannot_fill', '', `guard:${guard.reason}`);
      guardedInvalid.push(rawLabel);
      continue;
    }
    if (guard.action === 'answer') {
      answer = guard.answer;
      source = guard.source;
      guardBackedAnswer = true;
    } else if (hadWrongValue) {
      // Field has a WRONG value — the tier cascade already failed for this field.
      // Go straight to LLM with error context so it can produce the right format.
      if (options.llmCache && options.llmBudget && options.llmBudget.callsRemaining > 0) {
        const mode = (tagName === 'textarea' || rawLabel.length > 80) ? 'long' : 'short';
        // Build a prompt that includes the error message and the wrong value
        const retryPrompt = errorMessage
          ? `${rawLabel}\n\n[Previous answer "${currentValue}" was rejected. Validation error: "${errorMessage}". Provide a corrected answer in the required format.]`
          : `${rawLabel}\n\n[Previous answer "${currentValue}" was rejected. Provide a corrected answer.]`;

        const startMs = Date.now();
        const llmAnswer = await generateAnswer(retryPrompt, options.jobContext || {}, options.llmCache, logger, mode);
        const elapsed = Date.now() - startMs;
        options.llmBudget.callsRemaining--;
        options.llmBudget.msRemaining -= elapsed;

        if (llmAnswer && llmAnswer !== FALLBACK_ANSWER) {
          answer = llmAnswer;
          source = `llm:retry_${mode}`;
        }
      }

      // If LLM didn't help, try Tier 2 rules (maybe the fuzzy match was wrong but rules are right)
      if (answer === null) {
        const ruleResult = inferByRules(normalLabel, rawLabel, tagName === 'select' ? 'select' : 'text', config);
        if (ruleResult && ruleResult.answer !== currentValue) {
          answer = ruleResult.answer;
          source = ruleResult.rule;
        }
      }
    } else {
      // Field is empty — standard tier cascade
      // Tier 1: fuzzy match
      answer = findAnswer(normalLabel, answers);
      source = 'defaultAnswers';

      // Tier 2: rule-based
      if (answer === null) {
        const ruleResult = inferByRules(normalLabel, rawLabel, tagName === 'select' ? 'select' : 'text', config);
        if (ruleResult) {
          answer = ruleResult.answer;
          source = ruleResult.rule;
        }
      }

      // Tier 3: LLM (budgeted)
      if (answer === null && options.llmCache && options.llmBudget && options.llmBudget.callsRemaining > 0) {
        const mode = (tagName === 'textarea' || rawLabel.length > 80) ? 'long' : 'short';
        const startMs = Date.now();
        const llmAnswer = await generateAnswer(rawLabel, options.jobContext || {}, options.llmCache, logger, mode);
        const elapsed = Date.now() - startMs;
        options.llmBudget.callsRemaining--;
        options.llmBudget.msRemaining -= elapsed;

        if (llmAnswer && llmAnswer !== FALLBACK_ANSWER) {
          answer = llmAnswer;
          source = `llm:${mode}`;
        }
      }
    }

    // Output validation (spec R11): the retry pass fills through the same
    // validator as the primary tiers — this path is exactly how a
    // [PORTFOLIO_URL] placeholder reached a live form on 2026-07-14.
    if (answer !== null) {
      const v = validateAnswer(answer, { label: rawLabel, fieldType: tagName === 'select' ? 'select' : tagName, inputType });
      if (!v.ok) {
        logger.debug({ platform, jobId, field: rawLabel, rejectedLength: String(answer).length, reason: v.reason }, 'Retry output guard rejected answer');
        answer = null;
      }
    }

    if (answer !== null) {
      if (tagName === 'select') {
        // For selects, try to find matching option
        const optionDetails = await el.$$eval('option', opts =>
          opts.map(o => ({ text: o.textContent.trim(), value: o.value, index: o.index }))
        ).catch(() => []);
        const nonPlaceholder = optionDetails.filter(o => o.text && !/^(|select|choose|please select)$/i.test(o.text));
        if (nonPlaceholder.length > 0) {
          const matched = guardBackedAnswer
            ? matchStrictOption(answer, nonPlaceholder)
            : matchDropdownOption(answer, nonPlaceholder);
          if (matched) {
            const ok = await fillSelect(el, matched.index, matched.text, page);
            if (ok) {
              retryFilled++;
              auditFill(platform, jobId, runId, rawLabel, 'select', null, source, matched.text, 'retry');
            }
          }
        }
      } else {
        // Text input / textarea — clear old value first, then fill with new answer
        let fillValue = answer;
        if (inputType === 'number' && /^\d+$/.test(fillValue)) {
          fillValue = fillValue + '.0';
        }
        if (hadWrongValue) {
          await el.fill(''); // Clear the wrong value
          await sleep(100, 200);
        }
        await typeValue(page, el, fillValue, config);
        retryFilled++;
        auditFill(platform, jobId, runId, rawLabel, tagName, inputType, source, fillValue, 'retry');
      }
      logger.debug({ platform, jobId, field: rawLabel, source, hadWrongValue }, 'Retry filled invalid field');
    }
  }

  return { retryFilled, guardedInvalid };
}

module.exports = {
  fillForm,
  retryInvalidFields,
  findAnswer,
  normalizeLabel,
  inferByRules,
  typeValue,
  extractLabel,
};
