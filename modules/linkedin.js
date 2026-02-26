'use strict';

/**
 * LinkedIn Easy Apply Module
 *
 * Navigates to LinkedIn job search results (pre-filtered for Easy Apply),
 * identifies jobs with the "Easy Apply" button, and submits applications
 * through LinkedIn's multi-step modal.
 *
 * How the Easy Apply modal works:
 * - LinkedIn renders an overlay modal with multiple "steps"
 * - Each step shows a "Next" button (or "Review" on the penultimate step,
 *   "Submit application" on the final step)
 * - Steps vary per employer: contact info, resume, screener questions
 * - We loop through steps until we see "Submit application"
 */

const path = require('path');
const fs = require('fs');
const { sleep, scrollLikeHuman } = require('../lib/humanize');
const { fillForm } = require('../lib/form-filler');
const { recordUnfilledField } = require('../lib/state');

// Maximum time to wait for selectors (ms)
const SELECTOR_TIMEOUT = 10000;

/**
 * Take an error screenshot and save it to logs/screenshots/
 */
async function screenshotError(page, platform, jobId, config) {
  if (!config.behavior?.screenshotOnError) return;
  try {
    const dir = path.join(process.cwd(), 'logs', 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const fname = `${today}-${platform}-${(jobId || 'unknown').replace(/[^a-z0-9]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(dir, fname), fullPage: false });
  } catch (_) {
    // Screenshot failures should never crash the run
  }
}

/**
 * Detect if LinkedIn is showing a CAPTCHA / security check page.
 *
 * LinkedIn embeds an invisible reCAPTCHA Enterprise widget (size=invisible)
 * on ALL pages for passive bot scoring.  This is NOT a blocking challenge —
 * we must ignore it.  Only trigger when a real blocking challenge is shown:
 *   1. Visible challenge text ("Let's do a quick security check", etc.)
 *   2. A visible (non-invisible) reCAPTCHA iframe
 *   3. The page lacks normal navigation, indicating a redirect to a
 *      standalone challenge page
 *
 * @returns {Promise<boolean>}
 */
async function isCaptchaPage(page) {
  try {
    // If the normal job-list or nav chrome is present, the page loaded fine.
    const hasJobList = (await page.$('.jobs-search-results-list, .scaffold-layout__list')) !== null;
    const hasNav = (await page.$('.global-nav, #global-nav')) !== null;
    if (hasJobList || hasNav) return false;

    // No normal page elements — check for visible challenge text
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    if (
      bodyText.includes("Let's do a quick security check") ||
      bodyText.includes('Verify you\'re not a robot') ||
      bodyText.includes('unusual activity')
    ) {
      return true;
    }

    // Check for a visible (non-invisible) reCAPTCHA iframe
    const hasVisibleCaptchaIframe = await page.evaluate(() => {
      const iframes = document.querySelectorAll('iframe[src*="captcha"], iframe[src*="challenge"]');
      for (const f of iframes) {
        const src = f.src || '';
        // Skip LinkedIn's passive invisible widget
        if (src.includes('size=invisible')) continue;
        // Check if the iframe is actually visible
        const rect = f.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
      return false;
    });
    if (hasVisibleCaptchaIframe) return true;

    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Extract the LinkedIn job ID from a job card element.
 * LinkedIn encodes the job ID in data attributes or the href.
 */
async function extractJobId(card) {
  // Try data-job-id attribute first
  const dataId = await card.getAttribute('data-job-id');
  if (dataId) return dataId;

  // Try to find a link with /jobs/view/{id}
  const link = await card.$('a[href*="/jobs/view/"]');
  if (link) {
    const href = await link.getAttribute('href');
    const match = href.match(/\/jobs\/view\/(\d+)/);
    if (match) return match[1];
  }

  // Fallback: use the entity URN
  const urn = await card.getAttribute('data-occludable-job-id');
  return urn || null;
}

/**
 * Handle a single step of the LinkedIn Easy Apply modal.
 * Fills visible fields, then clicks Next/Review/Submit.
 *
 * @param {import('playwright').Page} page
 * @param {object} defaultAnswers
 * @param {object} config
 * @param {object} logger
 * @param {string} jobId
 * @param {boolean} dryRun
 * @param {number} stepNum - 1-based modal step index for logging/diagnostics
 * @returns {Promise<'next'|'submitted'|'error'|'validation_error'>}
 */
async function handleModalStep(page, defaultAnswers, config, logger, jobId, dryRun, stepNum) {
  // Give the step content time to render
  await sleep(800, 1500);

  // ── Capture step diagnostics ──
  const stepInfo = await page.evaluate(() => {
    const modal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal');
    if (!modal) return { progress: '?', labels: [], fields: [], errors: [] };

    // Progress indicator (e.g. "57%")
    const progressEl = modal.querySelector('progress, [role="progressbar"], [class*="progress"]');
    const progress = progressEl
      ? (progressEl.getAttribute('aria-valuenow') || progressEl.getAttribute('value') || progressEl.textContent || '').trim()
      : '?';

    // All labels in the modal
    const labels = [];
    for (const lbl of modal.querySelectorAll('label, legend, [class*="question"], [data-test-form-element-label]')) {
      const t = (lbl.textContent || '').trim().substring(0, 120);
      if (t) labels.push(t);
    }

    // All form fields with their type, value, and visibility
    const fields = [];
    for (const el of modal.querySelectorAll('input, select, textarea, [role="combobox"], [aria-haspopup="listbox"]')) {
      const rect = el.getBoundingClientRect();
      fields.push({
        tag: el.tagName,
        type: el.type || el.getAttribute('role') || '',
        id: (el.id || '').substring(0, 80),
        visible: rect.width > 0 && rect.height > 0,
        value: (el.value || el.textContent || '').trim().substring(0, 60),
      });
    }

    // Validation errors
    const errors = [];
    for (const err of modal.querySelectorAll('[class*="error"], [class*="invalid"], [role="alert"]')) {
      const t = (err.textContent || '').trim();
      if (t) errors.push(t.substring(0, 100));
    }

    return { progress, labels, fields, errors };
  }).catch(() => ({ progress: '?', labels: [], fields: [], errors: [] }));

  logger.debug({ platform: 'linkedin', jobId, stepNum, progress: stepInfo.progress, labels: stepInfo.labels,
    fields: stepInfo.fields.map(f => `${f.tag}(${f.type})${f.visible ? '' : '[hidden]'}`),
  }, 'Modal step diagnostics');
  if (stepInfo.errors.length) logger.debug({ platform: 'linkedin', jobId, stepNum, errors: stepInfo.errors }, 'Validation errors on step');

  // ── Resume step: select existing resume if present ──
  // LinkedIn shows uploaded resumes as selectable cards with radio buttons.
  // If none is selected, the "Next" button silently refuses to advance.
  const resumeRadios = await page.$$('input[type="radio"][id*="jobsDocumentCardToggle"]');
  if (resumeRadios.length > 0) {
    let anyChecked = false;
    for (const r of resumeRadios) {
      if (await r.isChecked()) { anyChecked = true; break; }
    }
    if (!anyChecked) {
      // Click the label of the first resume radio (the input is visually hidden)
      const firstId = await resumeRadios[0].getAttribute('id');
      if (firstId) {
        const label = await page.$(`label[for="${firstId}"]`);
        if (label) {
          await label.click();
        } else {
          await resumeRadios[0].click({ force: true });
        }
        await sleep(300, 600);
        logger.debug({ platform: 'linkedin', jobId }, 'Selected first resume option');
      }
    } else {
      logger.debug({ platform: 'linkedin', jobId }, 'Resume already selected');
    }
  }

  // Fill any visible form fields on this step
  const { filledCount, unfilledFields } = await fillForm(
    page,
    defaultAnswers,
    config,
    logger,
    'linkedin',
    jobId
  );

  // Record unmatched fields for future improvement
  for (const field of unfilledFields) {
    recordUnfilledField({ platform: 'linkedin', jobId, fieldLabel: field.fieldLabel, fieldType: field.fieldType });
  }

  logger.debug({ platform: 'linkedin', jobId, filledCount, unfilledCount: unfilledFields.length,
    unfilledFields: unfilledFields.map(f => `${f.fieldLabel} (${f.fieldType})`),
  }, 'Step form fill summary');

  // Uncheck "Follow company" if present on review step.
  // The checkbox input is hidden behind a <label> on LinkedIn, so click
  // the label instead (same pattern as radio buttons).
  const followCheckbox = await page.$('input[type="checkbox"][id*="follow"]');
  if (followCheckbox) {
    const isChecked = await followCheckbox.isChecked().catch(() => false);
    if (isChecked) {
      const cbId = await followCheckbox.getAttribute('id');
      const cbLabel = cbId ? await page.$(`label[for="${cbId}"]`) : null;
      if (cbLabel && await cbLabel.isVisible()) {
        await cbLabel.click();
      } else {
        await followCheckbox.click({ force: true });
      }
      await sleep(200, 400);
    }
  }

  await sleep(500, 1000);

  // Determine which button to click based on what's visible
  // Priority: "Submit application" > "Review" > "Next" > "Continue"
  const buttonSelectors = [
    { selector: 'button[aria-label="Submit application"]', action: 'submit' },
    { selector: 'button:has-text("Submit application")', action: 'submit' },
    { selector: 'button[aria-label="Review your application"]', action: 'next' },
    { selector: 'button:has-text("Review")', action: 'next' },
    { selector: 'button[aria-label="Continue to next step"]', action: 'next' },
    { selector: 'button:has-text("Next")', action: 'next' },
    { selector: 'button:has-text("Continue")', action: 'next' },
  ];

  for (const { selector, action } of buttonSelectors) {
    const btn = await page.$(selector);
    if (btn && (await btn.isVisible())) {
      const btnText = (await btn.innerText()).trim();
      logger.debug({ platform: 'linkedin', jobId, btnText, action }, 'Clicking modal button');

      if (action === 'submit') {
        if (dryRun) {
          await screenshotError(page, 'linkedin', `dryrun-${jobId}`, config);
          logger.info({ jobId }, '[DRY RUN] Would submit application — taking screenshot instead');

          // Dismiss the modal cleanly: click X → wait for "Discard" confirmation → click Discard
          const dismissBtn = await page.$('button[aria-label="Dismiss"]');
          if (dismissBtn) {
            await dismissBtn.click();
            await sleep(500, 1000);
            // LinkedIn shows a confirmation overlay asking "Discard application?"
            const discardBtn = await page.waitForSelector(
              '[data-test-easy-apply-discard-confirmation] button[data-control-name="discard_application_confirm"], ' +
              '[data-test-modal-id="data-test-easy-apply-discard-confirmation"] button:has-text("Discard"), ' +
              'button[data-control-name="discard_application_confirm"], ' +
              'button:has-text("Discard")',
              { timeout: 5000 }
            ).catch(() => null);
            if (discardBtn) {
              await discardBtn.click();
              await sleep(500, 1000);
            }
          }

          return 'submitted';
        }
        await btn.click();
        return 'submitted';
      } else {
        await btn.click();
        await sleep(500, 800);

        // Check for validation errors that appeared after clicking
        const postClickErrors = await page.evaluate(() => {
          const modal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal');
          if (!modal) return [];
          const errs = [];
          for (const el of modal.querySelectorAll('[class*="error"], [role="alert"], [class*="invalid"]')) {
            const t = (el.textContent || '').trim();
            if (t) errs.push(t.substring(0, 100));
          }
          return errs;
        }).catch(() => []);

        if (postClickErrors.length > 0) {
          logger.debug({ platform: 'linkedin', jobId, errors: postClickErrors }, 'Post-click validation errors');
          return 'validation_error';
        }

        return 'next';
      }
    }
  }

  // No recognizable button found
  logger.warn({ jobId }, 'Could not find Next/Submit button on modal step');
  return 'error';
}

/**
 * Main LinkedIn Easy Apply function.
 *
 * @param {import('playwright').Page} page
 * @param {object} config - full config.json
 * @param {object} defaultAnswers - defaultAnswers.json
 * @param {object} state - state manager module
 * @param {string} runId
 * @param {object} logger
 * @param {boolean} [dryRun=false]
 * @returns {Promise<{ applied: number, skipped: number, errors: number }>}
 */
/**
 * Build a LinkedIn search URL dynamically from config.search.keywords.
 * - Keywords are joined with " OR " and URL-encoded
 * - geoId=103644278 = "United States"
 * - f_AL=true = Easy Apply filter
 * - f_TPR=r604800 = Past week
 */
function buildSearchUrl(config) {
  const keywords = (config.search?.keywords || ['data scientist']).join(' OR ');
  const encoded = encodeURIComponent(keywords);
  return `https://www.linkedin.com/jobs/search/?keywords=${encoded}&geoId=103644278&f_AL=true&f_TPR=r604800`;
}

async function applyLinkedIn(page, config, defaultAnswers, state, runId, logger, dryRun = false) {
  const platformConfig = config.platforms.linkedin;
  const maxApplications = platformConfig.maxApplicationsPerRun;
  const { minDelayBetweenApplications, maxDelayBetweenApplications } = config.behavior;

  const maxRetries = config.behavior?.maxRetries ?? 0;
  const retryAttempts = new Map(); // jobId → number of retries made

  let applied = 0;
  let skipped = 0;
  let errors = 0;

  // Construct search URL dynamically from config.search.keywords
  const searchUrl = buildSearchUrl(config);
  logger.info({ platform: 'linkedin', searchUrl }, 'Navigating to LinkedIn search');

  // Navigate to dynamically constructed search URL
  // geoId=103644278 (United States) + URL-encoded keywords + f_AL=true + f_TPR=r604800
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000, 4000);

  // Check for CAPTCHA immediately after navigation (PRD §8.2)
  if (await isCaptchaPage(page)) {
    logger.error({ platform: 'linkedin' }, 'CAPTCHA detected at search page. Stopping LinkedIn.');
    state.recordApplication({
      platform: 'linkedin', jobId: 'captcha_detected',
      status: 'captcha_blocked', errorMessage: 'CAPTCHA detected — platform stopped', runId,
    });
    return { applied, skipped, errors };
  }

  let pageHasMoreJobs = true;

  while (applied < maxApplications && pageHasMoreJobs) {
    // Wait for the job list container to be present
    // waitForSelector auto-waits up to the timeout — no need for manual sleep here
    try {
      await page.waitForSelector('.jobs-search-results-list, .scaffold-layout__list', {
        timeout: SELECTOR_TIMEOUT,
      });
    } catch (_) {
      logger.warn({ platform: 'linkedin' }, 'Job list not found — may have reached end of results');
      break;
    }

    // Query job cards fresh from the live DOM.
    // We use index-based iteration and re-query each time because clicking a
    // card, opening a modal, or dismissing it can mutate the DOM and
    // invalidate previously-held element handles.
    // Job cards live inside the scrollable left-hand list. We scope all card
    // queries to this container so we never accidentally match filter chips,
    // nav elements, or other page-level nodes.
    const LIST_SELECTOR = '.jobs-search-results-list, [class*="jobs-search-results"], .scaffold-layout__list';
    let pageAlive = true;

    // Only match <li> elements that contain an actual job link — this filters
    // out spacer elements, ad slots, promoted cards, and skeleton placeholders
    // that don't have job data and cause extractJobId to return null.
    const initialCards = await page.$$(`${LIST_SELECTOR} li`);
    const jobCards = [];
    for (const li of initialCards) {
      const hasJobLink = await li.$('a[href*="/jobs/view/"]');
      const hasJobId = await li.getAttribute('data-occludable-job-id');
      if (hasJobLink || hasJobId) jobCards.push(li);
    }
    const totalCardCount = jobCards.length;
    logger.info({ platform: 'linkedin', cardCount: totalCardCount, totalLi: initialCards.length }, 'Found job cards');

    // Build a CARD_SELECTOR that re-queries only real job cards on each iteration.
    // We use data-occludable-job-id which is the most reliable marker.
    const CARD_SELECTOR = `${LIST_SELECTOR} li[data-occludable-job-id], ${LIST_SELECTOR} li:has(a[href*="/jobs/view/"])`;

    for (let cardIdx = 0; cardIdx < totalCardCount && applied < maxApplications; cardIdx++) {
      // ── Re-query the card list so we always have a live handle ──
      let freshCards;
      try {
        freshCards = await page.$$(CARD_SELECTOR);
      } catch (reQueryErr) {
        logger.warn({ platform: 'linkedin', error: reQueryErr.message }, 'Failed to query cards — page may have closed');
        pageAlive = false;
        break;
      }
      if (cardIdx >= freshCards.length) {
        logger.debug({ platform: 'linkedin', cardIdx, freshCount: freshCards.length }, 'Card list shrank — skipping remaining');
        break;
      }
      const card = freshCards[cardIdx];

      let jobId = null;
      let jobTitle = null;
      let company = null;
      let jobUrl = null;

      // Extract jobId FIRST, before any clicks.  If this fails the element
      // handle is unusable — skip the card entirely without recording.
      try {
        jobId = await extractJobId(card);
      } catch (extractErr) {
        logger.debug({ platform: 'linkedin', cardIdx, reason: 'extract_failed', error: extractErr.message }, 'Skipping card');
        skipped++;
        continue;
      }
      if (!jobId) {
        logger.debug({ platform: 'linkedin', cardIdx, reason: 'no_job_id' }, 'Skipping card');
        skipped++;
        continue;
      }

      // Quick-extract title/company from the card before any clicks for logging
      try {
        const titleEl = await card.$('a[class*="job-card-list__title"], a[class*="job-card-container__link"], [class*="job-title"], strong');
        if (titleEl) jobTitle = (await titleEl.innerText()).trim().replace(/\n.*/s, '');
        const companyEl = await card.$('[class*="company-name"], [class*="primary-description"], [class*="subtitle"]');
        if (companyEl) company = (await companyEl.innerText()).trim().replace(/\n.*/s, '');
      } catch (_) {}

      try {
        // Check if already applied (SQLite lookup)
        if (state.hasApplied('linkedin', jobId)) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, company, reason: 'already_applied_db' }, 'Skipping job');
          state.recordApplication({ platform: 'linkedin', jobId, jobTitle, company, status: 'already_applied', skipReason: 'already_applied_db', runId });
          skipped++;
          continue;
        }

        // Click the job card's title link to load the detail panel on the right.
        const cardLink = await card.$('a[class*="job-card-list__title"], a[class*="job-card-container__link"], a[href*="/jobs/view/"]');
        const clickTarget = cardLink || card;

        await clickTarget.click();
        await sleep(1500, 3000);

        // Wait for the job DETAIL PANEL (right side) to load
        const DETAIL_SELECTOR = '.jobs-search__job-details, .job-details, .jobs-details, .jobs-details__main-content, .job-view-layout';
        await page.waitForSelector(DETAIL_SELECTOR, {
          timeout: SELECTOR_TIMEOUT,
        });

        // Get the current URL for this job
        jobUrl = page.url();

        // The "Easy Apply" button lives inside the detail panel (right side),
        // NOT in the job card list. Scope the search to the detail container.
        const detailPanel = await page.$(DETAIL_SELECTOR);
        let easyApplyBtn = null;
        if (detailPanel) {
          easyApplyBtn = await detailPanel.$('button.jobs-apply-button, button[aria-label*="Easy Apply"]');
        }
        // Fallback: use Playwright's role-based locator scoped to detail panel
        if (!easyApplyBtn) {
          const loc = page.getByRole('button', { name: /easy apply/i });
          if (await loc.count() > 0) {
            easyApplyBtn = await loc.first().elementHandle();
          }
        }

        if (!easyApplyBtn) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, company, reason: 'no_easy_apply_button' }, 'Skipping job');
          state.recordApplication({
            platform: 'linkedin', jobId, jobTitle, company, jobUrl,
            status: 'skipped', skipReason: 'no_easy_apply_button', runId,
          });
          skipped++;
          continue;
        }

        const isVisible = await easyApplyBtn.isVisible();
        if (!isVisible) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, company, reason: 'easy_apply_not_visible' }, 'Skipping job');
          skipped++;
          continue;
        }

        // Check if we've already applied (LinkedIn sometimes shows this in the button)
        const btnText = await easyApplyBtn.innerText();

        if (btnText.toLowerCase().includes('applied')) {
          logger.debug({ platform: 'linkedin', jobId, jobTitle, company, reason: 'already_applied_linkedin' }, 'Skipping job');
          state.recordApplication({
            platform: 'linkedin', jobId, jobTitle, company, jobUrl,
            status: 'already_applied', skipReason: 'already_applied_linkedin', runId,
          });
          skipped++;
          continue;
        }

        // Click Easy Apply to open the modal
        logger.info({ jobId, jobTitle, company }, 'Opening Easy Apply modal');
        await easyApplyBtn.click();
        await sleep(1500, 2500);

        // Wait for the modal to appear
        const modal = await page.waitForSelector(
          '.jobs-easy-apply-modal, [data-test-modal], .artdeco-modal',
          { timeout: SELECTOR_TIMEOUT }
        ).catch(() => null);

        if (!modal) {
          throw new Error('Easy Apply modal did not open');
        }

        // Check for "already applied" message inside the modal
        const alreadyAppliedMsg = await page.$('text="Your application was sent"');
        if (alreadyAppliedMsg) {
          const dismissBtn = await page.$('button[aria-label="Dismiss"], button:has-text("Done")');
          if (dismissBtn) await dismissBtn.click();
          state.recordApplication({
            platform: 'linkedin', jobId, jobTitle, company, jobUrl,
            status: 'already_applied', skipReason: 'already_applied_linkedin', runId,
          });
          skipped++;
          continue;
        }

        // Process multi-step modal — keep clicking Next until we Submit.
        // Track step identity by fingerprinting field labels so we detect
        // cycles (modal wrapping back to an earlier step) reliably.
        let stepCount = 0;
        let modalComplete = false;
        const seenFingerprints = new Set();
        const MAX_STEPS = 12; // Safeguard against infinite loops

        while (!modalComplete && stepCount < MAX_STEPS) {
          stepCount++;

          // Fingerprint this step by its field labels
          const fingerprint = await page.evaluate(() => {
            const modal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal');
            if (!modal) return '';
            const labels = [];
            for (const lbl of modal.querySelectorAll('label, legend, [data-test-form-element-label]')) {
              const t = (lbl.textContent || '').trim().substring(0, 60);
              if (t) labels.push(t);
            }
            return labels.sort().join('||');
          }).catch(() => '');

          if (fingerprint && seenFingerprints.has(fingerprint)) {
            logger.warn({ platform: 'linkedin', jobId, step: stepCount }, 'Modal cycled back to a previously seen step — skipping job');
            throw new Error('Modal cycled — unfilled required fields on an earlier step');
          }
          if (fingerprint) seenFingerprints.add(fingerprint);

          const result = await handleModalStep(page, defaultAnswers, config, logger, jobId, dryRun, stepCount);

          if (result === 'submitted') {
            modalComplete = true;

            if (!dryRun) {
              // Wait for LinkedIn's success confirmation overlay
              await page.waitForSelector(
                'text="Application submitted", text="Your application was sent", .artdeco-toast-item--success',
                { timeout: 10000 }
              ).catch(() => null);
            }

            logger.info({ jobId, jobTitle, company, steps: stepCount }, 'Application submitted');
            state.recordApplication({
              platform: 'linkedin', jobId, jobTitle, company, jobUrl,
              status: dryRun ? 'dry_run' : 'submitted', runId,
            });
            applied++;

            // Dismiss the post-submit success dialog / modal.
            // LinkedIn may show "Done", "Not now", or an X button — try
            // multiple approaches since labels can intercept pointer events.
            await sleep(1000, 2000);
            let dismissed = false;

            // Try each dismiss strategy
            const dismissSelectors = [
              'button[aria-label="Dismiss"]',
              'button:has-text("Done")',
              'button:has-text("Not now")',
            ];
            for (const sel of dismissSelectors) {
              if (dismissed) break;
              try {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                  await btn.click({ force: true }); // force bypasses label intercepts
                  dismissed = true;
                  await sleep(500, 1000);
                }
              } catch (_) {}
            }

            // If the modal is still blocking, press Escape as a last resort
            if (!dismissed) {
              try {
                await page.keyboard.press('Escape');
                await sleep(500, 1000);
              } catch (_) {}
            }

            // Wait for the modal overlay to fully close
            await page.waitForSelector('.jobs-easy-apply-modal, .artdeco-modal', {
              state: 'hidden',
              timeout: 5000,
            }).catch(() => null);

            // Verify the job list is accessible again before continuing
            try {
              await page.waitForSelector(LIST_SELECTOR, { timeout: 5000 });
            } catch (_) {
              logger.warn({ platform: 'linkedin' }, 'Job list not visible after submit — attempting recovery');
              // Try scrolling up to reveal the list
              await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
              await sleep(1000, 2000);
            }

          } else if (result === 'validation_error') {
            // Clicking Next triggered validation errors — required fields are
            // unfilled and the modal won't advance.  Skip this job immediately.
            throw new Error(`Validation errors on step ${stepCount} — required fields unfilled`);
          } else if (result === 'error') {
            throw new Error(`Could not navigate modal step ${stepCount}`);
          }
          // 'next' → continue loop to next step
        }

        if (!modalComplete) {
          throw new Error(`Modal exceeded ${MAX_STEPS} steps without submitting`);
        }

        // Wait between applications (human-like pacing)
        await sleep(minDelayBetweenApplications, maxDelayBetweenApplications);

      } catch (err) {
        // Robustly close any open modal to prevent state leaking into the
        // next job.  Sequence: dismiss → discard confirm → verify closed →
        // force-navigate if still stuck.
        try {
          const dismissBtn = await page.$('button[aria-label="Dismiss"]');
          if (dismissBtn) {
            await dismissBtn.click({ force: true });
            await sleep(800, 1500);

            const discardBtn = await page.waitForSelector(
              'button[data-control-name="discard_application_confirm"]',
              { timeout: 5000 }
            ).catch(() => null);

            if (discardBtn) {
              await discardBtn.click({ force: true });
              await sleep(500, 1000);
            } else {
              const fallbackDiscard = await page.$('button:has-text("Discard")');
              if (fallbackDiscard) {
                await fallbackDiscard.click({ force: true });
                await sleep(500, 1000);
              }
            }
          }

          // Wait for the modal to fully close
          await page.waitForSelector('.jobs-easy-apply-modal, .artdeco-modal', {
            state: 'hidden',
            timeout: 5000,
          }).catch(() => null);
        } catch (_) {
          try { await page.keyboard.press('Escape'); } catch (__) {}
          await sleep(1000, 2000);
        }

        // Verify the modal is actually gone.  If not, force-navigate back
        // to the search URL to reset page state completely.
        const modalStillOpen = await page.$('.jobs-easy-apply-modal, .artdeco-modal').catch(() => null);
        if (modalStillOpen) {
          logger.warn({ platform: 'linkedin', jobId }, 'Modal still open after dismiss — force-navigating to search URL');
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await sleep(2000, 3000);
        }

        await sleep(2000, 4000);

        // Check for CAPTCHA before deciding whether to retry (PRD §8.2)
        if (await isCaptchaPage(page)) {
          logger.error({ platform: 'linkedin' }, 'CAPTCHA detected — stopping LinkedIn');
          state.recordApplication({
            platform: 'linkedin', jobId: 'captcha_detected',
            status: 'captcha_blocked', errorMessage: 'CAPTCHA detected — platform stopped', runId,
          });
          return { applied, skipped, errors };
        }

        // Retry transient errors up to maxRetries times (re-visit same index)
        const attemptsMade = (retryAttempts.get(jobId) || 0) + 1;
        if (attemptsMade <= maxRetries) {
          retryAttempts.set(jobId, attemptsMade);
          logger.warn({ platform: 'linkedin', jobId, attempt: attemptsMade, error: err.message }, 'Transient error — will retry');
          cardIdx--; // decrement so the for-loop re-visits this index with a fresh handle
        } else {
          logger.error({ platform: 'linkedin', jobId, jobTitle, error: err.message }, 'Application error');
          errors++;
          await screenshotError(page, 'linkedin', jobId, config);
          state.recordApplication({
            platform: 'linkedin', jobId, jobTitle, company, jobUrl,
            status: 'error', errorMessage: err.message, runId,
          });
        }
      }
    }

    // If the page/context was closed mid-run, exit the outer loop too
    if (!pageAlive) break;

    // Pagination: scroll down to load more jobs or find "See more jobs" button
    if (applied < maxApplications) {
      const seeMoreBtn = await page.$('button:has-text("See more jobs"), button[aria-label*="See more jobs"]');
      if (seeMoreBtn && await seeMoreBtn.isVisible()) {
        await seeMoreBtn.click();
        await sleep(2000, 4000);
      } else {
        // Try scrolling the job list to trigger infinite scroll
        const jobList = await page.$('.jobs-search-results-list');
        if (jobList) {
          await page.evaluate((el) => el.scrollTo(0, el.scrollHeight), jobList);
          await sleep(2000, 3000);

          // Check if new cards loaded
          const newCards = await page.$$(CARD_SELECTOR);
          if (newCards.length <= totalCardCount) {
            pageHasMoreJobs = false;
          }
        } else {
          pageHasMoreJobs = false;
        }
      }
    }
  }

  return { applied, skipped, errors };
}

module.exports = { applyLinkedIn };
