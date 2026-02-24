'use strict';

const stringSimilarity = require('string-similarity');
const { sleep, typeWithDelay } = require('./humanize');

const FUZZY_THRESHOLD = 0.6;

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
 * Fill all detectable form fields on the current page/modal with answers
 * from defaultAnswers, using fuzzy matching and safe fallbacks.
 *
 * @param {import('playwright').Page} page
 * @param {object} defaultAnswers - from defaultAnswers.json
 * @param {object} config - full config (for resumePath, user info, etc.)
 * @param {object} logger - pino logger
 * @param {string} [platform] - platform name for logging
 * @param {string} [jobId] - job ID for logging
 * @returns {Promise<{ filledCount: number, unfilledFields: Array }>}
 */
async function fillForm(page, defaultAnswers, config, logger, platform = 'unknown', jobId = null) {
  const answers = defaultAnswers.defaultAnswers || defaultAnswers;
  let filledCount = 0;
  const unfilledFields = [];

  // ─────────────────────────────────────────────────────────────────────
  // TEXT INPUTS & TEXTAREAS
  // ─────────────────────────────────────────────────────────────────────
  const textInputs = await page.$$('input[type="text"], input[type="number"], input[type="tel"], input[type="email"], textarea');

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
    const answer = findAnswer(normalLabel, answers);

    if (answer !== null) {
      // Use humanized per-character typing for non-empty answers to avoid
      // instant-fill detection. Empty answers are filled silently (nothing to type).
      if (answer === '') {
        await input.fill('');
      } else {
        const typingConfig = config.behavior?.typingSpeed || {};
        await typeWithDelay(page, await input.evaluate((el) => {
          // Build a unique CSS selector for this element to pass to typeWithDelay
          if (el.id) return `#${CSS.escape(el.id)}`;
          if (el.name) return `[name="${CSS.escape(el.name)}"]`;
          return null;
        }), answer, { min: typingConfig.min || 50, max: typingConfig.max || 150 }).catch(async () => {
          // Fallback: if typeWithDelay can't target the element, use fill()
          await input.fill(answer);
          await sleep(100, 300);
        });
      }
      filledCount++;
      logger.debug({ platform, jobId, field: rawLabel, answer }, 'Filled text field');
    } else if (normalLabel) {
      // Log unmatched fields for future improvement
      unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'text' });
      logger.debug({ platform, jobId, field: rawLabel }, 'No match for text field — leaving empty');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SELECT DROPDOWNS
  // ─────────────────────────────────────────────────────────────────────
  const selects = await page.$$('select');

  for (const select of selects) {
    const isVisible = await select.isVisible();
    if (!isVisible) continue;

    // Skip if already has a non-placeholder selection
    const selectedValue = await select.inputValue().catch(() => '');
    if (selectedValue && selectedValue !== '' && selectedValue !== '0' && selectedValue !== 'placeholder') {
      continue;
    }

    const rawLabel = await extractLabel(page, select);
    const normalLabel = normalizeLabel(rawLabel);
    const answer = findAnswer(normalLabel, answers);

    // Get all options
    const options = await select.$$('option');
    const optionTexts = [];
    for (const opt of options) {
      optionTexts.push(await opt.innerText());
    }

    if (answer !== null) {
      // Try to find option matching the answer
      const { bestMatch: bestOpt } = stringSimilarity.findBestMatch(
        answer.toLowerCase(),
        optionTexts.map((t) => t.toLowerCase())
      );
      if (bestOpt.rating >= 0.4) {
        const matchedText = optionTexts.find(
          (t) => t.toLowerCase() === bestOpt.target
        );
        if (matchedText) {
          await select.selectOption({ label: matchedText });
          await sleep(100, 300);
          filledCount++;
          logger.debug({ platform, jobId, field: rawLabel, selected: matchedText }, 'Selected dropdown option');
        }
      }
    } else if (optionTexts.length > 1) {
      // Safe default: select first non-placeholder option
      const firstReal = optionTexts.find(
        (t) => t.trim() && !['select', 'choose', 'please', '-- select', ''].includes(t.trim().toLowerCase())
      );
      if (firstReal) {
        await select.selectOption({ label: firstReal });
        await sleep(100, 200);
        filledCount++;
        if (rawLabel) unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'select' });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // RADIO BUTTONS
  // ─────────────────────────────────────────────────────────────────────
  // Find all radio button groups (group by name attribute)
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
    const answer = findAnswer(normalLabel, answers);

    // Collect option labels for each radio
    const radioOptions = [];
    for (const r of groupRadios) {
      const optLabel = await extractLabel(page, r);
      radioOptions.push({ radio: r, label: optLabel });
    }

    if (answer !== null) {
      // Find the radio whose label best matches the answer
      const { bestMatch } = stringSimilarity.findBestMatch(
        answer.toLowerCase(),
        radioOptions.map((o) => o.label.toLowerCase())
      );
      const matched = radioOptions.find((o) => o.label.toLowerCase() === bestMatch.target);
      if (matched && bestMatch.rating >= 0.4) {
        await matched.radio.click();
        await sleep(100, 300);
        filledCount++;
        logger.debug({ platform, jobId, group: groupName, selected: matched.label }, 'Selected radio button');
      }
    } else {
      // Safe default: click "Yes" if available, otherwise first option
      const yesOption = radioOptions.find((o) => o.label.toLowerCase().includes('yes'));
      const toClick = yesOption || radioOptions[0];
      if (toClick) {
        await toClick.radio.click();
        await sleep(100, 300);
        filledCount++;
        if (questionLabel) unfilledFields.push({ fieldLabel: questionLabel, fieldType: 'radio' });
      }
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

    // Only auto-check checkboxes with "agree", "certify", "confirm", "acknowledge" language
    const CONSENT_WORDS = ['agree', 'certify', 'confirm', 'acknowledge', 'accept', 'consent'];
    const isConsent = CONSENT_WORDS.some((word) => normalLabel.includes(word));

    if (isConsent) {
      await checkbox.click();
      await sleep(100, 300);
      filledCount++;
      logger.debug({ platform, jobId, field: rawLabel }, 'Checked consent checkbox');
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
      // page.setInputFiles() is Playwright's native file upload method
      await fileInput.setInputFiles(fullPath);
      await sleep(500, 1000);
      filledCount++;
      logger.debug({ platform, jobId, file: fullPath }, 'Uploaded resume file');
    } else {
      logger.warn({ platform, jobId, resumePath: fullPath }, 'Resume file not found — skipping file upload');
    }
  }

  return { filledCount, unfilledFields };
}

module.exports = {
  fillForm,
  findAnswer,
  normalizeLabel,
};
