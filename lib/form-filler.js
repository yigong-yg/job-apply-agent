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
 * Click a radio button, handling the common case where a <label> element
 * overlays the <input> and intercepts pointer events.
 *
 * Strategy (tried in order):
 * 1. Find the associated <label> (via the radio's id) and click that.
 * 2. If no label found, use force:true to bypass Playwright's
 *    actionability check and click the input directly.
 */
async function clickRadio(page, radioEl) {
  const id = await radioEl.getAttribute('id');
  if (id) {
    const label = await page.$(`label[for="${id}"]`);
    if (label && await label.isVisible()) {
      await label.click();
      return;
    }
  }
  // Fallback: force-click the radio input itself
  await radioEl.click({ force: true });
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
      // For number inputs, ensure the value is decimal-formatted if the field
      // requires it.  LinkedIn sometimes validates "Enter a decimal number
      // larger than 0.0" — whole numbers like "2" fail, but "2.0" passes.
      let fillValue = answer;
      const inputType = await input.getAttribute('type').catch(() => 'text');
      if (inputType === 'number' && /^\d+$/.test(fillValue)) {
        fillValue = fillValue + '.0';
      }

      // Use humanized per-character typing for non-empty answers to avoid
      // instant-fill detection. Empty answers are filled silently (nothing to type).
      if (fillValue === '') {
        await input.fill('');
      } else {
        const typingConfig = config.behavior?.typingSpeed || {};
        await typeWithDelay(page, await input.evaluate((el) => {
          if (el.id) return `#${CSS.escape(el.id)}`;
          if (el.name) return `[name="${CSS.escape(el.name)}"]`;
          return null;
        }), fillValue, { min: typingConfig.min || 50, max: typingConfig.max || 150 }).catch(async () => {
          await input.fill(fillValue);
          await sleep(100, 300);
        });
      }
      filledCount++;
      logger.debug({ platform, jobId, field: rawLabel, answer: fillValue }, 'Filled text field');
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

    // Skip if already has a non-placeholder selection.
    // Both the raw value AND the visible option text are checked against
    // common placeholder patterns so we don't skip unset dropdowns.
    const selectedValue = await select.inputValue().catch(() => '');
    const selectedText = await select.evaluate(el => {
      const opt = el.options[el.selectedIndex];
      return opt ? opt.textContent.trim() : '';
    }).catch(() => '');
    const placeholderPattern = /^(|0|placeholder|select|select an option|choose|please select|-- select|--select--)$/i;
    if (selectedValue && !placeholderPattern.test(selectedValue) && !placeholderPattern.test(selectedText)) {
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
      // Try to find option matching the answer.
      // Get option values alongside text for robust selection.
      const optionDetails = await select.$$eval('option', opts =>
        opts.map(o => ({ text: o.textContent.trim(), value: o.value, index: o.index }))
      );

      const nonPlaceholderOpts = optionDetails.filter(o =>
        o.text && !placeholderPattern.test(o.text)
      );

      if (nonPlaceholderOpts.length > 0) {
        const { bestMatch: bestOpt } = stringSimilarity.findBestMatch(
          answer.toLowerCase(),
          nonPlaceholderOpts.map((o) => o.text.toLowerCase())
        );
        if (bestOpt.rating >= 0.4) {
          const matched = nonPlaceholderOpts.find(o => o.text.toLowerCase() === bestOpt.target);
          if (matched) {
            const ok = await fillSelect(select, matched.index, matched.text, page);
            if (ok) {
              await sleep(100, 300);
              filledCount++;
              logger.debug({ platform, jobId, field: rawLabel, selected: matched.text }, 'Selected dropdown option');
            }
          }
        }
      }
    } else if (optionTexts.length > 1) {
      // Safe default: select first non-placeholder option
      const firstRealIdx = optionTexts.findIndex(
        (t) => t.trim() && !placeholderPattern.test(t.trim())
      );
      if (firstRealIdx >= 0) {
        const ok = await fillSelect(select, firstRealIdx, optionTexts[firstRealIdx], page);
        if (ok) {
          await sleep(100, 200);
          filledCount++;
          if (rawLabel) unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'select' });
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // LINKEDIN CUSTOM DROPDOWNS (non-native <select>)
  // ─────────────────────────────────────────────────────────────────────
  // LinkedIn Easy Apply modals often use custom React dropdown components
  // instead of native <select>.  These render as a clickable trigger
  // (typically <button> or <div> with role="combobox" or
  // aria-haspopup="listbox") that opens a listbox overlay with
  // role="option" items.
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
    const answer = findAnswer(normalLabel, answers);

    if (!answer) {
      if (normalLabel) unfilledFields.push({ fieldLabel: rawLabel, fieldType: 'custom-dropdown' });
      continue;
    }

    try {
      // Check if there's a hidden native <select> inside or nearby that we
      // can set programmatically (LinkedIn sometimes wraps a real <select>
      // in a styled container).
      const hiddenSelect = await trigger.$('select') ||
        await trigger.evaluateHandle(el => {
          // Walk up to the field container and look for a <select>
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
        // Native select found — use selectOption with fuzzy match
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
            // Dispatch change event so React picks up the change
            await hiddenSelect.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
            await sleep(200, 400);
            filledCount++;
            logger.debug({ platform, jobId, field: rawLabel, selected: matchedText }, 'Selected custom dropdown (native select)');
            continue;
          }
        }
      }

      // No native <select> — use click-based interaction
      await trigger.click();
      await sleep(300, 600);

      // Wait for the listbox / dropdown options to appear
      const listbox = await page.waitForSelector('[role="listbox"], [role="option"], [data-test-text-selectable-option__label]', {
        timeout: 3000,
      }).catch(() => null);

      if (!listbox) {
        logger.debug({ platform, jobId, field: rawLabel }, 'Custom dropdown did not open');
        continue;
      }

      // Find all options in the dropdown
      const options = await page.$$('[role="option"], [data-test-text-selectable-option__label], [role="listbox"] li');
      let matched = false;

      for (const opt of options) {
        const optText = (await opt.innerText()).trim();
        if (optText.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(optText.toLowerCase())) {
          await opt.click();
          await sleep(200, 400);
          filledCount++;
          matched = true;
          logger.debug({ platform, jobId, field: rawLabel, selected: optText }, 'Selected custom dropdown option');
          break;
        }
      }

      // If exact/substring match failed, try fuzzy match
      if (!matched && options.length > 0) {
        const optTexts = [];
        for (const opt of options) {
          optTexts.push((await opt.innerText()).trim());
        }
        const { bestMatch } = stringSimilarity.findBestMatch(
          answer.toLowerCase(),
          optTexts.map(t => t.toLowerCase())
        );
        if (bestMatch.rating >= 0.4) {
          const matchIdx = optTexts.findIndex(t => t.toLowerCase() === bestMatch.target);
          if (matchIdx >= 0) {
            await options[matchIdx].click();
            await sleep(200, 400);
            filledCount++;
            matched = true;
            logger.debug({ platform, jobId, field: rawLabel, selected: optTexts[matchIdx] }, 'Selected custom dropdown option (fuzzy)');
          }
        }
      }

      // Close dropdown if it's still open (click elsewhere)
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
        await clickRadio(page, matched.radio);
        await sleep(100, 300);
        filledCount++;
        logger.debug({ platform, jobId, group: groupName, selected: matched.label }, 'Selected radio button');
      }
    } else {
      // Safe default: click "Yes" if available, otherwise first option
      const yesOption = radioOptions.find((o) => o.label.toLowerCase().includes('yes'));
      const toClick = yesOption || radioOptions[0];
      if (toClick) {
        await clickRadio(page, toClick.radio);
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
