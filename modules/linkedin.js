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
const { recordUnfilledField } = require('../lib/state');
const { queueAppNotification } = require('../lib/notify');

const SELECTOR_TIMEOUT = 10000;

// ── Exact daily-limit message (must remain exact-match) ──
const LINKEDIN_DAILY_SUBMISSION_LIMIT_MESSAGE =
  'We limit daily submissions to maintain quality and prevent bots, helping each application get the right attention. Save this job and apply tomorrow.';

function normalizeVisibleText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function hasLinkedInDailySubmissionLimitMessage(text) {
  return normalizeVisibleText(text).includes(
    normalizeVisibleText(LINKEDIN_DAILY_SUBMISSION_LIMIT_MESSAGE)
  );
}

// ── Job filter (pure, no network) ──

function shouldApply(title, company, config) {
  const filter = config.search?.jobFilter;
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
async function fillShadowForm(page, defaultAnswers, logger, jobId) {
  const result = await page.evaluate((answers) => {
    const interop = document.querySelector('#interop-outlet');
    if (!interop || !interop.shadowRoot) return { filled: 0, unfilled: [] };
    const sr = interop.shadowRoot;

    let filled = 0;
    const unfilled = [];
    const answerMap = answers.defaultAnswers || answers;

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

      const match = fuzzyMatch(labelText);
      if (match) {
        if (el.tagName === 'SELECT') {
          for (const opt of el.options) {
            if (opt.text.toLowerCase().includes(match.toLowerCase()) ||
                match.toLowerCase().includes(opt.text.toLowerCase())) {
              el.value = opt.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              filled++;
              break;
            }
          }
        } else {
          el.value = match;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
      } else if (labelText) {
        unfilled.push({ label: labelText, type: el.type || el.tagName });
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

      // Find group label from parent fieldset/div
      const parent = radios[0].closest('fieldset, div, li');
      const groupLabel = parent ? (parent.querySelector('legend, label')?.textContent || '').trim() : '';
      const match = fuzzyMatch(groupLabel);

      if (match) {
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
            break;
          }
        }
        // If no label matched, click "Yes" if available (safe default for binary questions)
        if (!clicked) {
          for (const radio of radios) {
            const radioLabel = getLabelText(radio) || radio.value || '';
            if (radioLabel.toLowerCase() === 'yes') {
              radio.checked = true;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
              filled++;
              break;
            }
          }
        }
      } else if (groupLabel) {
        unfilled.push({ label: groupLabel, type: 'radio' });
      }
    }

    // ── Handle standalone checkboxes (agree/certify/confirm) ──
    for (const cb of sr.querySelectorAll('input[type="checkbox"]')) {
      if (cb.checked) continue;
      const labelText = getLabelText(cb) || '';
      const labelLower = labelText.toLowerCase();
      if (labelLower.includes('agree') || labelLower.includes('certify') ||
          labelLower.includes('confirm') || labelLower.includes('acknowledge')) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      }
    }

    return { filled, unfilled };
  }, defaultAnswers).catch(() => ({ filled: 0, unfilled: [] }));

  if (result.filled > 0) {
    logger.debug({ platform: 'linkedin', jobId, filled: result.filled }, 'Filled shadow DOM form fields');
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
  params.set('f_TPR', 'r86400');
  params.set('f_AL', 'true');
  if (li.f_SAL) params.set('f_SAL', li.f_SAL);

  return `https://www.linkedin.com/jobs/search-results/?${params.toString()}`;
}

// ══════════════════════════════════════════════════════════
//  Result Card Helpers
// ══════════════════════════════════════════════════════════

/**
 * Find all result card buttons on the current page.
 * Cards are accessible as role=button via Playwright's getByRole.
 * They contain "Easy Apply" in their text and are on the top-level page.
 */
async function listResultCards(page) {
  // Wait for at least one card to render
  try {
    await page.getByRole('button').filter({ hasText: 'Easy Apply' }).first().waitFor({ timeout: SELECTOR_TIMEOUT });
  } catch (_) {}
  return page.getByRole('button').filter({ hasText: 'Easy Apply' }).all();
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
  // First meaningful line is the title (may include "(Verified job)" suffix)
  let title = null;
  let company = null;
  let location = null;

  for (const line of lines) {
    // Skip very short lines, icons, dismiss buttons
    if (line.length < 3 || line.startsWith('Dismiss')) continue;
    if (!title) { title = line.replace(/\s*\(Verified job\)\s*/i, '').trim(); continue; }
    if (!company) { company = line; continue; }
    if (!location && /[A-Z]{2}\s*\(/.test(line)) { location = line; break; }
    if (!location && /remote/i.test(line)) { location = line; break; }
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

    // Easy Apply link
    const easyApplyLink = document.querySelector('a[aria-label="Easy Apply to this job"]');
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
  // Try the Easy Apply link (new UI: <a aria-label="Easy Apply to this job">)
  const easyApplyLink = page.locator('a[aria-label="Easy Apply to this job"]');
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

// ══════════════════════════════════════════════════════════
//  Inline Apply Step Handler
// ══════════════════════════════════════════════════════════

/**
 * Handle one step of the inline SDUI apply flow.
 * Replaces the old modal-centric handleModalStep().
 *
 * The apply form appears inline in the detail panel (or in the /preload/ iframe).
 * We fill fields, then click Next/Review/Submit.
 *
 * @param {import('playwright').Frame} frame - the LinkedIn app frame
 */
/**
 * Handle one step of the SDUI apply flow.
 * The form lives inside #interop-outlet → shadowRoot (shadow DOM).
 * Playwright's page.locator() pierces shadow DOM; page.$() and fillForm do NOT.
 * We use fillShadowForm() for field filling and page.locator() for button clicks.
 */
async function handleInlineApplyStep(page, defaultAnswers, config, logger, jobId, dryRun, stepNum, options = {}) {
  await sleep(800, 1500);

  // ── Fill form fields inside shadow DOM ──
  await fillShadowForm(page, defaultAnswers, logger, jobId);

  // Also try standard fillForm on the page for non-shadow fields (fallback)
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
  const postClickErrors = await page.evaluate(() => {
    const interop = document.querySelector('#interop-outlet');
    if (!interop || !interop.shadowRoot) return [];
    const sr = interop.shadowRoot;
    const errs = [];
    for (const el of sr.querySelectorAll('[class*="error"], [role="alert"], [class*="invalid"]')) {
      const t = (el.textContent || '').trim();
      if (t && t.length > 3 && !t.includes('Required')) errs.push(t.substring(0, 100));
    }
    // Also check for "Please enter a valid answer" pattern
    const allText = sr.textContent || '';
    if (allText.includes('Please enter a valid answer')) errs.push('Please enter a valid answer');
    return errs;
  }).catch(() => []);

  if (postClickErrors.length > 0) {
    logger.debug({ platform: 'linkedin', jobId, errors: postClickErrors }, 'Shadow DOM validation errors');
    // Try filling again with shadow form filler
    const retry = await fillShadowForm(page, defaultAnswers, logger, jobId);
    if (retry.filled > 0) {
      await sleep(300, 600);
      await btn.evaluate(e => e.click());
      await sleep(1000, 1500);
      // Recheck
      const stillErrors = await page.evaluate(() => {
        const interop = document.querySelector('#interop-outlet');
        if (!interop || !interop.shadowRoot) return false;
        return interop.shadowRoot.textContent.includes('Please enter a valid answer');
      }).catch(() => false);
      if (stillErrors) return 'retry_failed';
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
    const cards = await page.getByRole('button').filter({ hasText: 'Easy Apply' }).count();
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
      const cards = await page.getByRole('button').filter({ hasText: 'Easy Apply' }).count();
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

  // ── Crash diagnostics (gitignored logs/) ──
  page.on('crash', () => {
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
    if (cards.length === 0) break;

    for (let i = 0; i < cards.length && applied < maxApplications; i++) {
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
          skipped++;
          continue;
        }

        jobTitle = summary.title;
        company = summary.company;

        // Early-skip: card shows "Applied" badge
        if (summary.hasAppliedBadge) {
          skipped++;
          continue;
        }

        // ── Step 2: Job filter (before clicking into detail) ──
        const { apply: passFilter, skipReason: filterReason } = shouldApply(jobTitle, company, config);
        if (!passFilter) {
          logger.debug({ platform: 'linkedin', jobTitle, company, reason: filterReason }, 'Filtered out');
          // We don't have jobId yet — record with title as identifier
          recordAndNotify({ status: 'skipped', jobId: 'filtered', jobTitle, company, skipReason: filterReason, source });
          skipped++;
          continue;
        }

        // ── Step 3: Click card to load detail ──
        await selectCard(card);

        // ── Step 4: Extract detail (jobId, promoted, easyApply) ──
        const detail = await extractSelectedJobDetail(page);
        if (!detail || !detail.jobId) {
          logger.debug({ platform: 'linkedin', jobTitle, company, reason: 'no_job_id' }, 'Could not extract job ID from detail');
          skipped++;
          continue;
        }

        jobId = detail.jobId;
        jobUrl = detail.jobUrl;
        source = detail.isPromoted ? 'promoted' : 'organic';

        // Prefer detail-level title/company if available
        if (detail.title) jobTitle = detail.title;
        if (detail.company) company = detail.company;

        // ── Skip promoted jobs (detail-verified, not card-level) ──
        if (detail.isPromoted) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, company, reason: 'promoted' }, 'Skipping promoted job');
          recordAndNotify({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: 'promoted', source });
          skipped++;
          continue;
        }

        // ── Guard: skip jobs that already failed this session ──
        if (failedJobIds.has(jobId)) {
          logger.debug({ platform: 'linkedin', jobId, reason: 'already_failed_this_session' }, 'Skipping');
          skipped++;
          continue;
        }

        // ── Step 5: DB dedup (now that we have canonical jobId) ──
        if (state.hasApplied('linkedin', jobId)) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, reason: 'already_applied_db' }, 'Skipping');
          recordAndNotify({ status: 'already_applied', jobId, jobTitle, company, jobUrl, skipReason: 'already_applied_db', source });
          skipped++;
          continue;
        }

        // Already applied per LinkedIn's detail panel
        if (detail.alreadyApplied) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, reason: 'already_applied_linkedin' }, 'Skipping');
          recordAndNotify({ status: 'already_applied', jobId, jobTitle, company, jobUrl, skipReason: 'already_applied_linkedin', source });
          skipped++;
          continue;
        }

        // ── Step 6: Enter Easy Apply ──
        if (!detail.easyApplyHref) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, reason: 'no_easy_apply_button' }, 'Skipping');
          recordAndNotify({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: 'no_easy_apply_button', source });
          skipped++;
          continue;
        }

        logger.info({ jobId, jobTitle, company, source }, 'Entering Easy Apply');
        const entryResult = await enterEasyApply(page, logger);

        if (entryResult === 'already_applied') {
          recordAndNotify({ status: 'already_applied', jobId, jobTitle, company, jobUrl, skipReason: 'already_applied_linkedin', source });
          skipped++;
          continue;
        }
        if (entryResult === 'no_easy_apply') {
          recordAndNotify({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: 'no_easy_apply_button', source });
          skipped++;
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
          recordAndNotify({ status: 'skipped', jobId, jobTitle, company, jobUrl, skipReason: 'daily_limit_reached', source });
          skipped++;
          return { applied, skipped, errors, stopSession: true, stopSessionReason: 'linkedin_daily_submission_limit' };
        }

        // ── Step 7: Process inline apply steps ──
        const llmBudget = { callsRemaining: 5, msRemaining: 20000 };
        const fillOptions = {
          jobContext: { jobTitle, company, jobDescription: detail.description || '' },
          llmCache: llmCache || undefined,
          llmBudget,
          runId,
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
            throw new Error('Apply flow cycled — unfilled required fields');
          }
          if (fingerprint) seenFingerprints.add(fingerprint);

          const result = await handleInlineApplyStep(page, defaultAnswers, config, logger, jobId, dryRun, stepCount, fillOptions);

          if (result === 'retry_failed') {
            throw new Error(`Validation errors on step ${stepCount} — retry failed`);
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
            recordAndNotify({ status: dryRun ? 'dry_run' : 'submitted', jobId, jobTitle, company, jobUrl, steps: stepCount, source });
            applied++;

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

        logger.error({ platform: 'linkedin', jobId, jobTitle, error: err.message }, 'Application error');
        errors++;
        if (jobId) failedJobIds.add(jobId);
        await screenshotError(page, 'linkedin', jobId, config);
        recordAndNotify({ status: 'error', jobId: jobId || 'unknown', jobTitle, company, jobUrl, errorMessage: err.message, source });
      }
    }

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

  return { applied, skipped, errors };
}

module.exports = {
  applyLinkedIn,
  // Exported for testing
  buildLinkedInSearchUrl,
  summarizeResultCard,
  shouldApply,
  hasLinkedInDailySubmissionLimitMessage,
  normalizeVisibleText,
};
