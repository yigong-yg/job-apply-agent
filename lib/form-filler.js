'use strict';

const stringSimilarity = require('string-similarity');
const { sleep, typeWithDelay } = require('./humanize');
const { generateAnswer, FALLBACK_ANSWER } = require('./llm');
const { recordFillAudit, recordUnfilledField } = require('./state');

const FUZZY_THRESHOLD = 0.6;

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
const POSITIVE_PATTERNS = [
  'authorized to work', 'willing to relocate', 'able to commute',
  'over 18', 'legally authorized', 'comfortable with', 'experience with',
  'legally eligible', 'willing to travel', 'able to work',
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

  // Also try direct substring inclusion as a fallback
  for (const key of keys) {
    if (label.includes(key) || key.includes(label)) {
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
function inferByRules(normalLabel, rawLabel, fieldType, config) {
  const user = config.user || {};

  // Config-backed rules (highest confidence — answer from user's own data)
  const rules = [
    { rule: 'years_experience', test: () => normalLabel.includes('years') && normalLabel.includes('experience'), answer: user.yearsOfExperience },
    { rule: 'city_location', test: () => (normalLabel.includes('city') || (normalLabel.includes('location') && !normalLabel.includes('relocation') && !normalLabel.includes('relocate'))), answer: user.city },
    { rule: 'state_province', test: () => normalLabel.includes('state') || normalLabel.includes('province'), answer: user.state },
    { rule: 'zip_code', test: () => normalLabel.includes('zip') || normalLabel.includes('postal'), answer: user.zipCode },
    { rule: 'salary', test: () => normalLabel.includes('salary') || normalLabel.includes('compensation') || normalLabel.includes('pay rate') || normalLabel.includes('desired pay'), answer: user.desiredSalary },
    { rule: 'start_date', test: () => normalLabel.includes('start date') || normalLabel.includes('when can you start') || normalLabel.includes('earliest start'), answer: user.startDate },
    { rule: 'email_field', test: () => normalLabel.includes('email') && fieldType === 'text', answer: user.email },
    { rule: 'phone_field', test: () => normalLabel.includes('phone') && fieldType === 'text', answer: user.phone },
    { rule: 'linkedin_url', test: () => normalLabel.includes('linkedin'), answer: user.linkedinUrl },
    { rule: 'work_auth', test: () => normalLabel.includes('authorized') || normalLabel.includes('authorization'), answer: user.workAuthorization },
    { rule: 'sponsorship', test: () => normalLabel.includes('sponsor'), answer: user.requiresSponsorship ? 'Yes' : 'No' },
    { rule: 'veteran', test: () => normalLabel.includes('veteran'), answer: user.veteranStatus },
    { rule: 'disability', test: () => normalLabel.includes('disability'), answer: user.disabilityStatus },
    { rule: 'gender', test: () => normalLabel.includes('gender'), answer: user.gender },
    { rule: 'race_ethnicity', test: () => normalLabel.includes('race') || normalLabel.includes('ethnicity'), answer: user.race },
    { rule: 'gpa', test: () => normalLabel.includes('gpa') || normalLabel.includes('grade point'), answer: '3.8' },
    { rule: 'hear_about', test: () => normalLabel.includes('hear about') || normalLabel.includes('referred'), answer: 'Job Board' },
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
  // Strategy 1: Check for an associated <label> via id/for attribute
  const id = await element.getAttribute('id');
  if (id) {
    const labelEl = await page.$(`label[for="${id}"]`);
    if (labelEl) {
      const text = await labelEl.innerText();
      if (text.trim()) return text.trim();
    }
  }

  // Strategy 2: aria-label attribute
  const ariaLabel = await element.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // Strategy 3: aria-labelledby
  const labelledBy = await element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = await page.$(`#${labelledBy}`);
    if (labelEl) {
      const text = await labelEl.innerText();
      if (text.trim()) return text.trim();
    }
  }

  // Strategy 4: placeholder attribute
  const placeholder = await element.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();

  // Strategy 5: name attribute
  const name = await element.getAttribute('name');
  if (name && name.trim()) return name.replace(/[_-]/g, ' ').trim();

  // Strategy 6: Look for nearby text in parent container
  try {
    const nearbyText = await element.evaluate((el) => {
      // Walk up the DOM looking for label-like text near this element
      let parent = el.parentElement;
      for (let i = 0; i < 4; i++) {
        if (!parent) break;
        // Check for a sibling <label> or text node
        const label = parent.querySelector('label, [class*="label"], [class*="Label"]');
        if (label && label !== el) {
          const text = label.textContent.trim();
          if (text) return text;
        }
        // Check the parent's own text (excluding child element text)
        const ownText = Array.from(parent.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent.trim())
          .join(' ')
          .trim();
        if (ownText) return ownText;
        parent = parent.parentElement;
      }
      return '';
    });
    if (nearbyText && nearbyText.trim()) return nearbyText.trim();
  } catch (_) {
    // Ignore evaluate errors (shadow DOM, cross-frame, etc.)
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
 * Click a radio button or checkbox, handling the common case where a <label>
 * element overlays the <input> and intercepts pointer events.
 *
 * Strategy (tried in order):
 * 1. Find the associated <label> (via the input's id) and click that.
 * 2. If no label found, use force:true to bypass Playwright's
 *    actionability check and click the input directly.
 */
async function clickInput(page, inputEl) {
  const id = await inputEl.getAttribute('id');
  if (id) {
    const label = await page.$(`label[for="${id}"]`);
    if (label && await label.isVisible()) {
      await label.click();
      return;
    }
  }
  // Fallback: force-click the input itself
  await inputEl.click({ force: true });
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
  const typingConfig = config.behavior?.typingSpeed || {};
  await typeWithDelay(page, await input.evaluate((el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    return null;
  }), value, { min: typingConfig.min || 50, max: typingConfig.max || 150 }).catch(async () => {
    await input.fill(value);
    await sleep(100, 300);
  });

  // ── Autocomplete/typeahead dropdown handling ──
  // Many platforms (LinkedIn, Indeed) show a dropdown after typing in
  // city/address/location fields. We need to select from the dropdown
  // or the form won't accept the value.
  await handleAutocompleteDropdown(page, input, value);
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
async function handleAutocompleteDropdown(page, input, typedValue) {
  // Wait briefly for dropdown to render (autocomplete is async)
  await sleep(400, 800);

  // Check if the input has an associated listbox via aria-controls or aria-owns
  const listboxId = await input.getAttribute('aria-controls').catch(() => null) ||
                    await input.getAttribute('aria-owns').catch(() => null);

  let dropdownOptions = [];

  if (listboxId) {
    // Scoped lookup via ARIA relationship
    dropdownOptions = await page.$$(`#${listboxId} [role="option"], #${listboxId} li`).catch(() => []);
  }

  // Fallback: look for any visible listbox/typeahead near the input
  if (dropdownOptions.length === 0) {
    dropdownOptions = await page.$$(
      '[role="listbox"] [role="option"], ' +
      '.basic-typeahead__selectable, ' +
      '[data-basic-typeahead-option], ' +
      '.autocomplete-suggestion, ' +
      '.pac-item'
    ).catch(() => []);
  }

  // Filter to only visible options
  const visibleOptions = [];
  for (const opt of dropdownOptions) {
    const isVisible = await opt.isVisible().catch(() => false);
    if (isVisible) visibleOptions.push(opt);
  }

  if (visibleOptions.length === 0) return;

  // Find the best matching option by text similarity
  const optTexts = [];
  for (const opt of visibleOptions) {
    optTexts.push((await opt.innerText().catch(() => '')).trim());
  }

  // Try exact substring match first (e.g. "Salt Lake City" in "Salt Lake City, UT, United States")
  let bestIdx = optTexts.findIndex(t =>
    t.toLowerCase().includes(typedValue.toLowerCase()) ||
    typedValue.toLowerCase().includes(t.toLowerCase())
  );

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
  const textInputs = await page.$$('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input[type="url"], textarea');

  for (const input of textInputs) {
    // Skip hidden, disabled, or readonly inputs
    const isVisible = await input.isVisible();
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

    // ── Tier 1: Fuzzy match against defaultAnswers ──
    let answer = findAnswer(normalLabel, answers);

    // Format guard: reject non-numeric fuzzy matches for numeric-expecting fields.
    // Labels like "how many years of experience with Python" fuzzy-match
    // "do you have experience with python" → "Yes", which is the wrong type.
    // Detect numeric intent and reject yes/no or text answers.
    const NUMERIC_INDICATORS = ['how many', 'number of', 'years of', 'months of', 'how long', 'total years', 'scale of', 'rate ', 'rating'];
    const looksNumeric = inputType === 'number' || NUMERIC_INDICATORS.some(kw => normalLabel.includes(kw));
    if (answer !== null && looksNumeric && !/^[\d.]+$/.test(answer)) {
      logger.debug({ platform, jobId, field: rawLabel, rejectedAnswer: answer }, 'Tier 1 format guard: rejected non-numeric answer for numeric field');
      answer = null; // Fall through to Tier 2
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
      logger.debug({ platform, jobId, field: rawLabel, answer: fillValue }, 'Filled text field (Tier 1)');
      continue;
    }

    // ── Tier 2: Rule-based inference ──
    const ruleResult = inferByRules(normalLabel, rawLabel, 'text', config);
    if (ruleResult) {
      let fillValue = ruleResult.answer;
      if (inputType === 'number' && /^\d+$/.test(fillValue)) {
        fillValue = fillValue + '.0';
      }
      await typeValue(page, input, fillValue, config);
      filledCount++;
      auditFill(platform, jobId, runId, rawLabel, tagName, inputType, ruleResult.rule, fillValue, 'rule');
      logger.debug({ platform, jobId, field: rawLabel, answer: fillValue, rule: ruleResult.rule }, 'Filled text field (Tier 2)');
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

      if (llmAnswer && llmAnswer !== FALLBACK_ANSWER) {
        await typeValue(page, input, llmAnswer, config);
        filledCount++;
        auditFill(platform, jobId, runId, rawLabel, tagName, inputType, `llm:${mode}`, llmAnswer, 'llm');
        logger.info({ platform, jobId, field: rawLabel.substring(0, 80), source: `llm:${mode}`, answerLength: llmAnswer.length }, 'Filled field via LLM (Tier 3)');
        continue;
      }
      // LLM returned fallback — fall through to cannot-fill
    }

    // ── Cannot-fill branch: schema-aware defaults ──
    if (tagName === 'textarea') {
      // Textarea: use fallback answer (low risk, may help pass validation)
      await typeValue(page, input, FALLBACK_ANSWER, config);
      filledCount++;
      auditFill(platform, jobId, runId, rawLabel, tagName, inputType, 'cannot_fill', FALLBACK_ANSWER, 'fallback');
      logger.debug({ platform, jobId, field: rawLabel }, 'Textarea filled with fallback (cannot_fill)');
    } else {
      // text/email/tel/number/url — leave empty (garbage would hard-fail validation)
      auditFill(platform, jobId, runId, rawLabel, tagName, inputType, 'cannot_fill', '', 'none');
      unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'text' });
      recordUnfilledField({ platform, jobId, fieldLabel: rawLabel, fieldType: 'text' });
      logger.debug({ platform, jobId, field: rawLabel }, 'No match for text field — leaving empty (cannot_fill)');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SELECT DROPDOWNS
  // ─────────────────────────────────────────────────────────────────────
  const selects = await page.$$('select');
  const placeholderPattern = /^(|0|placeholder|select|select an option|choose|please select|-- select|--select--)$/i;

  for (const select of selects) {
    const isVisible = await select.isVisible();
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

    // ── Safe default: select first non-placeholder option ──
    if (nonPlaceholderOpts.length > 0) {
      const firstReal = nonPlaceholderOpts[0];
      const ok = await fillSelect(select, firstReal.index, firstReal.text, page);
      if (ok) {
        await sleep(100, 200);
        filledCount++;
        auditFill(platform, jobId, runId, rawLabel, 'select', null, 'safe_default', firstReal.text, 'first_option');
        if (rawLabel) unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'select' });
        logger.debug({ platform, jobId, field: rawLabel, selected: firstReal.text }, 'Selected first option (safe_default)');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // LINKEDIN CUSTOM DROPDOWNS (non-native <select>)
  // ─────────────────────────────────────────────────────────────────────
  const customDropdowns = await page.$$('[data-test-text-selectable-option] select, [role="combobox"], [aria-haspopup="listbox"], [data-test-dropdown]');

  for (const trigger of customDropdowns) {
    const isVisible = await trigger.isVisible();
    if (!isVisible) continue;

    // Skip if it looks like it already has a selection (non-placeholder text)
    const currentText = await trigger.evaluate(el => (el.textContent || el.value || '').trim());
    if (currentText && !['select an option', 'select', 'choose', 'please select', ''].includes(currentText.toLowerCase())) {
      continue;
    }

    const rawLabel = await extractLabel(page, trigger);
    const normalLabel = normalizeLabel(rawLabel);

    // Tier 1: fuzzy match
    let answer = findAnswer(normalLabel, answers);

    // Tier 2: rule-based inference
    if (!answer) {
      const ruleResult = inferByRules(normalLabel, rawLabel, 'custom-dropdown', config);
      if (ruleResult) {
        answer = ruleResult.answer;
        // We'll audit below if we successfully select
      }
    }

    if (!answer) {
      if (normalLabel) {
        unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'custom-dropdown' });
        auditFill(platform, jobId, runId, rawLabel, 'custom-dropdown', null, 'cannot_fill', '', 'none');
      }
      continue;
    }

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
        const { bestMatch } = stringSimilarity.findBestMatch(
          answer.toLowerCase(),
          optionTexts.map(t => t.toLowerCase())
        );
        if (bestMatch.rating >= 0.4) {
          const matchedText = optionTexts.find(t => t.toLowerCase() === bestMatch.target);
          if (matchedText) {
            await hiddenSelect.selectOption({ label: matchedText });
            await hiddenSelect.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
            await sleep(200, 400);
            filledCount++;
            auditFill(platform, jobId, runId, rawLabel, 'custom-dropdown', null, 'defaultAnswers', matchedText, 'fuzzy');
            logger.debug({ platform, jobId, field: rawLabel, selected: matchedText }, 'Selected custom dropdown (native select)');
            continue;
          }
        }
      }

      // No native <select> — use click-based interaction
      await trigger.click();
      await sleep(300, 600);

      const listbox = await page.waitForSelector('[role="listbox"], [role="option"], [data-test-text-selectable-option__label]', {
        timeout: 3000,
      }).catch(() => null);

      if (!listbox) {
        logger.debug({ platform, jobId, field: rawLabel }, 'Custom dropdown did not open');
        continue;
      }

      const dropdownOptions = await page.$$('[role="option"], [data-test-text-selectable-option__label], [role="listbox"] li');
      let matched = false;

      for (const opt of dropdownOptions) {
        const optText = (await opt.innerText()).trim();
        if (optText.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(optText.toLowerCase())) {
          await opt.click();
          await sleep(200, 400);
          filledCount++;
          matched = true;
          auditFill(platform, jobId, runId, rawLabel, 'custom-dropdown', null, 'defaultAnswers', optText, 'substring');
          logger.debug({ platform, jobId, field: rawLabel, selected: optText }, 'Selected custom dropdown option');
          break;
        }
      }

      // If exact/substring match failed, try fuzzy match
      if (!matched && dropdownOptions.length > 0) {
        const optTexts = [];
        for (const opt of dropdownOptions) {
          optTexts.push((await opt.innerText()).trim());
        }
        const { bestMatch } = stringSimilarity.findBestMatch(
          answer.toLowerCase(),
          optTexts.map(t => t.toLowerCase())
        );
        if (bestMatch.rating >= 0.4) {
          const matchIdx = optTexts.findIndex(t => t.toLowerCase() === bestMatch.target);
          if (matchIdx >= 0) {
            await dropdownOptions[matchIdx].click();
            await sleep(200, 400);
            filledCount++;
            matched = true;
            auditFill(platform, jobId, runId, rawLabel, 'custom-dropdown', null, 'defaultAnswers', optTexts[matchIdx], 'fuzzy');
            logger.debug({ platform, jobId, field: rawLabel, selected: optTexts[matchIdx] }, 'Selected custom dropdown option (fuzzy)');
          }
        }
      }

      // Close dropdown if it's still open
      if (!matched) {
        await page.keyboard.press('Escape');
        await sleep(100, 200);
      }
    } catch (dropdownErr) {
      logger.debug({ platform, jobId, field: rawLabel, error: dropdownErr.message }, 'Custom dropdown interaction failed');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // RADIO BUTTONS
  // ─────────────────────────────────────────────────────────────────────
  const radios = await page.$$('input[type="radio"]');
  const radioGroups = new Map();

  for (const radio of radios) {
    const isVisible = await radio.isVisible();
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

    // ── Tier 1: Fuzzy match ──
    const answer = findAnswer(normalLabel, answers);

    if (answer !== null) {
      const { bestMatch } = stringSimilarity.findBestMatch(
        answer.toLowerCase(),
        radioOptions.map((o) => o.label.toLowerCase())
      );
      const matched = radioOptions.find((o) => o.label.toLowerCase() === bestMatch.target);
      if (matched && bestMatch.rating >= 0.4) {
        await clickInput(page, matched.radio);
        await sleep(100, 300);
        filledCount++;
        auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, 'defaultAnswers', matched.label, 'fuzzy');
        logger.debug({ platform, jobId, group: groupName, selected: matched.label }, 'Selected radio (Tier 1)');
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
        await clickInput(page, matched.radio);
        await sleep(100, 300);
        filledCount++;
        auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, ruleResult.rule, matched.label, 'rule');
        logger.debug({ platform, jobId, group: groupName, selected: matched.label, rule: ruleResult.rule }, 'Selected radio (Tier 2)');
        continue;
      }
    }

    // ── Safe default: click "Yes" if available, otherwise first option ──
    const yesOption = radioOptions.find((o) => o.label.toLowerCase().includes('yes'));
    const toClick = yesOption || radioOptions[0];
    if (toClick) {
      await clickInput(page, toClick.radio);
      await sleep(100, 300);
      filledCount++;
      auditFill(platform, jobId, runId, questionLabel || groupName, 'radio', null, 'safe_default', toClick.label, 'yes_or_first');
      if (questionLabel) unfilledFields.push({ fieldLabel: questionLabel, fieldType: 'radio' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // CHECKBOXES
  // ─────────────────────────────────────────────────────────────────────
  const checkboxes = await page.$$('input[type="checkbox"]');

  for (const checkbox of checkboxes) {
    const isVisible = await checkbox.isVisible();
    if (!isVisible) continue;

    const isChecked = await checkbox.isChecked();
    if (isChecked) continue;

    const rawLabel = await extractLabel(page, checkbox);
    const normalLabel = normalizeLabel(rawLabel || '');

    // Auto-check consent checkboxes
    const CONSENT_WORDS = ['agree', 'certify', 'confirm', 'acknowledge', 'accept', 'consent'];
    const isConsent = CONSENT_WORDS.some((word) => normalLabel.includes(word));

    if (isConsent) {
      await clickInput(page, checkbox);
      await sleep(100, 300);
      filledCount++;
      auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'rule:consent_checkbox', 'checked', 'consent');
      logger.debug({ platform, jobId, field: rawLabel }, 'Checked consent checkbox');
      continue;
    }

    // Required checkbox detection: check required/aria-required checkboxes
    const isRequired = await checkbox.evaluate(el =>
      el.required || el.getAttribute('aria-required') === 'true'
    ).catch(() => false);

    if (isRequired) {
      await clickInput(page, checkbox);
      await sleep(100, 300);
      filledCount++;
      auditFill(platform, jobId, runId, rawLabel, 'checkbox', null, 'rule:required_checkbox', 'checked', 'required');
      logger.debug({ platform, jobId, field: rawLabel }, 'Checked required checkbox');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // FILE UPLOADS (resume)
  // ─────────────────────────────────────────────────────────────────────
  const fileInputs = await page.$$('input[type="file"]');

  for (const fileInput of fileInputs) {
    const isVisible = await fileInput.isVisible();
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
    const els = await page.$$(sel).catch(() => []);
    for (const el of els) {
      const isVisible = await el.isVisible().catch(() => false);
      if (isVisible) invalidEls.push(el);
    }
  }

  // Strategy: find input/select/textarea elements that have a visible error
  // message in a nearby sibling or parent container. LinkedIn shows error
  // text like "Enter a decimal number" in elements with error/invalid classes.
  const fieldsWithErrors = await page.$$eval(
    'input:not([type="hidden"]), select, textarea',
    (els) => {
      const results = [];
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Walk up to 4 parents looking for error text
        let parent = el.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
          const errEls = parent.querySelectorAll('[class*="error"], [class*="invalid"], [class*="Error"], [role="alert"]');
          for (const e of errEls) {
            const t = (e.textContent || '').trim();
            if (t && t.length > 0 && t.length < 200) {
              // Found error text near this field
              const id = el.id || '';
              const name = el.name || '';
              results.push({ id, name });
              break;
            }
          }
          if (results.length > 0 && (results[results.length - 1].id === (el.id || '') && results[results.length - 1].name === (el.name || ''))) break;
          parent = parent.parentElement;
        }
      }
      return results;
    }
  ).catch(() => []);

  // Resolve the error-adjacent fields back to element handles
  for (const { id, name } of fieldsWithErrors) {
    let el = null;
    if (id) el = await page.$(`#${cssEscape(id)}`).catch(() => null);
    if (!el && name) el = await page.$(`[name="${cssEscape(name)}"]`).catch(() => null);
    if (el) {
      const isVisible = await el.isVisible().catch(() => false);
      if (isVisible) invalidEls.push(el);
    }
  }

  // Also check required fields that are empty
  const requiredEls = await page.$$('[required]:not([type="hidden"]), [aria-required="true"]:not([type="hidden"])').catch(() => []);
  for (const el of requiredEls) {
    const isVisible = await el.isVisible().catch(() => false);
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

  for (const el of uniqueInvalid) {
    const rawLabel = await extractLabel(page, el);
    if (!rawLabel) continue;

    const normalLabel = normalizeLabel(rawLabel);
    const tagName = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => 'input');
    const inputType = await el.getAttribute('type').catch(() => 'text');

    // Check if the field already has a value (which is WRONG — that's why it's invalid)
    const currentValue = await el.inputValue().catch(() => '');
    const hadWrongValue = currentValue.trim().length > 0;

    // Extract the error message near this field for LLM context
    const errorMessage = await extractErrorMessage(page, el);

    logger.debug({ platform, jobId, field: rawLabel, currentValue: currentValue.substring(0, 50), errorMessage: errorMessage.substring(0, 100), hadWrongValue }, 'Retry analyzing invalid field');

    let answer = null;
    let source = null;

    if (hadWrongValue) {
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

    if (answer !== null) {
      if (tagName === 'select') {
        // For selects, try to find matching option
        const optionDetails = await el.$$eval('option', opts =>
          opts.map(o => ({ text: o.textContent.trim(), value: o.value, index: o.index }))
        ).catch(() => []);
        const nonPlaceholder = optionDetails.filter(o => o.text && !/^(|select|choose|please select)$/i.test(o.text));
        if (nonPlaceholder.length > 0) {
          const { bestMatch } = stringSimilarity.findBestMatch(
            answer.toLowerCase(),
            nonPlaceholder.map(o => o.text.toLowerCase())
          );
          if (bestMatch.rating >= 0.4) {
            const matched = nonPlaceholder.find(o => o.text.toLowerCase() === bestMatch.target);
            if (matched) {
              const ok = await fillSelect(el, matched.index, matched.text, page);
              if (ok) {
                retryFilled++;
                auditFill(platform, jobId, runId, rawLabel, 'select', null, source, matched.text, 'retry');
              }
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

  return { retryFilled };
}

module.exports = {
  fillForm,
  retryInvalidFields,
  findAnswer,
  normalizeLabel,
  inferByRules,
};
