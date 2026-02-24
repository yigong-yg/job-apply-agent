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
 * Take an error screenshot and save it to logs/errors/
 */
async function screenshotError(page, platform, jobId, config) {
  if (!config.behavior?.screenshotOnError) return;
  try {
    const dir = path.join(process.cwd(), 'logs', 'errors');
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
 * @returns {Promise<boolean>}
 */
async function isCaptchaPage(page) {
  try {
    const content = await page.content();
    return (
      content.includes("Let's do a quick security check") ||
      content.includes('security check') ||
      content.includes('captcha') ||
      (await page.$('iframe[src*="captcha"]')) !== null ||
      (await page.$('iframe[src*="challenge"]')) !== null
    );
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
 * @returns {Promise<'next'|'submitted'|'error'>}
 */
async function handleModalStep(page, defaultAnswers, config, logger, jobId, dryRun) {
  // Give the step content time to render
  await sleep(800, 1500);

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

  logger.debug({ jobId, filledCount, unmatched: unfilledFields.length }, 'Filled modal step');

  // Handle resume step: prefer "Use last resume" if available
  const useLastResumeBtn = await page.$('button:has-text("Use last resume"), [data-test-resume-option]');
  if (useLastResumeBtn) {
    const isVisible = await useLastResumeBtn.isVisible();
    if (isVisible) {
      await useLastResumeBtn.click();
      await sleep(500, 1000);
    }
  }

  // Uncheck "Follow company" if present on review step
  const followCheckbox = await page.$('input[type="checkbox"][id*="follow"], label:has-text("Follow") input[type="checkbox"]');
  if (followCheckbox) {
    const isVisible = await followCheckbox.isVisible();
    const isChecked = await followCheckbox.isChecked();
    if (isVisible && isChecked) {
      await followCheckbox.click();
      await sleep(200, 400);
    }
  }

  await sleep(500, 1000);

  // Determine which button to click based on what's visible
  // Priority: "Submit application" > "Review" > "Next" > "Continue"
  const buttonSelectors = [
    // Final submit button
    { selector: 'button[aria-label="Submit application"]', action: 'submit' },
    { selector: 'button:has-text("Submit application")', action: 'submit' },
    // Review step (penultimate)
    { selector: 'button[aria-label="Review your application"]', action: 'next' },
    { selector: 'button:has-text("Review")', action: 'next' },
    // Next step
    { selector: 'button[aria-label="Continue to next step"]', action: 'next' },
    { selector: 'button:has-text("Next")', action: 'next' },
    { selector: 'button:has-text("Continue")', action: 'next' },
  ];

  for (const { selector, action } of buttonSelectors) {
    const btn = await page.$(selector);
    if (btn && (await btn.isVisible())) {
      if (action === 'submit') {
        if (dryRun) {
          // In dry-run mode, take screenshot instead of submitting
          await screenshotError(page, 'linkedin', `dryrun-${jobId}`, config);
          logger.info({ jobId }, '[DRY RUN] Would submit application — taking screenshot instead');
          // Click "Done" or dismiss the modal without submitting
          const doneBtn = await page.$('button[aria-label="Dismiss"], button:has-text("Discard")');
          if (doneBtn) await doneBtn.click();
          return 'submitted';
        }
        await btn.click();
        return 'submitted';
      } else {
        await btn.click();
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
async function applyLinkedIn(page, config, defaultAnswers, state, runId, logger, dryRun = false) {
  const platformConfig = config.platforms.linkedin;
  const maxApplications = platformConfig.maxApplicationsPerRun;
  const { minDelayBetweenApplications, maxDelayBetweenApplications } = config.behavior;

  let applied = 0;
  let skipped = 0;
  let errors = 0;

  logger.info({ platform: 'linkedin', searchUrl: platformConfig.searchUrl }, 'Navigating to LinkedIn search');

  // Navigate to the pre-configured search URL (includes Easy Apply filter f_AL=true)
  await page.goto(platformConfig.searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000, 4000);

  // Check for CAPTCHA immediately after navigation
  if (await isCaptchaPage(page)) {
    logger.error({ platform: 'linkedin' }, 'CAPTCHA detected at search page. Stopping LinkedIn.');
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

    // Get all job cards currently visible on the page
    const jobCards = await page.$$('.job-card-container, .jobs-search-results__list-item');
    logger.info({ platform: 'linkedin', cardCount: jobCards.length }, 'Found job cards');

    for (const card of jobCards) {
      if (applied >= maxApplications) break;

      let jobId = null;
      let jobTitle = null;
      let company = null;
      let jobUrl = null;

      try {
        // Extract job ID
        jobId = await extractJobId(card);
        if (!jobId) {
          skipped++;
          continue;
        }

        // Check if already applied (SQLite lookup)
        if (state.hasApplied('linkedin', jobId)) {
          logger.debug({ jobId }, 'Already applied — skipping');
          state.recordApplication({ platform: 'linkedin', jobId, status: 'already_applied', runId });
          skipped++;
          continue;
        }

        // Extract job title and company for logging
        const titleEl = await card.$('.job-card-list__title, .job-card-container__link');
        if (titleEl) jobTitle = (await titleEl.innerText()).trim();
        const companyEl = await card.$('.job-card-container__company-name, .job-card-container__primary-description');
        if (companyEl) company = (await companyEl.innerText()).trim();

        // Click the job card to load the detail panel
        await card.click();
        await sleep(1500, 3000);

        // Wait for the job detail panel to load
        await page.waitForSelector('.jobs-details__main-content, .job-view-layout', {
          timeout: SELECTOR_TIMEOUT,
        });

        // Get the current URL for this job
        jobUrl = page.url();

        // Check for the Easy Apply button in the detail panel
        // LinkedIn shows either "Easy Apply" (blue) or "Apply" (external redirect)
        const easyApplyBtn = await page.$(
          'button.jobs-apply-button[aria-label*="Easy Apply"], button:has-text("Easy Apply")'
        );

        if (!easyApplyBtn) {
          // No Easy Apply button — this job uses external application
          logger.debug({ jobId, jobTitle, company }, 'No Easy Apply button — skipping (external apply)');
          state.recordApplication({
            platform: 'linkedin', jobId, jobTitle, company, jobUrl,
            status: 'skipped', errorMessage: 'external_apply', runId,
          });
          skipped++;
          continue;
        }

        const isVisible = await easyApplyBtn.isVisible();
        if (!isVisible) {
          skipped++;
          continue;
        }

        // Check if we've already applied (LinkedIn sometimes shows this in the button)
        const btnText = await easyApplyBtn.innerText();
        if (btnText.toLowerCase().includes('applied')) {
          logger.debug({ jobId }, 'Already applied indicator on button — skipping');
          state.recordApplication({
            platform: 'linkedin', jobId, jobTitle, company, jobUrl,
            status: 'already_applied', runId,
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
            status: 'already_applied', runId,
          });
          skipped++;
          continue;
        }

        // Process multi-step modal — keep clicking Next until we Submit
        let stepCount = 0;
        let modalComplete = false;
        const MAX_STEPS = 10; // Safeguard against infinite loops

        while (!modalComplete && stepCount < MAX_STEPS) {
          stepCount++;
          const result = await handleModalStep(page, defaultAnswers, config, logger, jobId, dryRun);

          if (result === 'submitted') {
            modalComplete = true;
            // Wait for confirmation message
            await page.waitForSelector(
              'text="Application submitted", text="Your application was sent", .artdeco-toast-item--success',
              { timeout: 10000 }
            ).catch(() => null);
            logger.info({ jobId, jobTitle, company, steps: stepCount }, 'Application submitted');
            state.recordApplication({
              platform: 'linkedin', jobId, jobTitle, company, jobUrl,
              status: dryRun ? 'dry_run' : 'submitted', runId,
            });
            applied++;

            // Close the success modal/dialog
            await sleep(1000, 2000);
            const doneBtn = await page.$('button[aria-label="Dismiss"], button:has-text("Done"), button:has-text("Not now")');
            if (doneBtn) await doneBtn.click();

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
        logger.error({ platform: 'linkedin', jobId, jobTitle, error: err.message }, 'Application error');
        errors++;

        await screenshotError(page, 'linkedin', jobId, config);

        state.recordApplication({
          platform: 'linkedin', jobId, jobTitle, company, jobUrl,
          status: 'error', errorMessage: err.message, runId,
        });

        // Try to close the modal if it's stuck open
        try {
          const dismissBtn = await page.$(
            'button[aria-label="Dismiss"], button[aria-label="Cancel"], .jobs-easy-apply-modal__dismiss'
          );
          if (dismissBtn) {
            await dismissBtn.click();
            await sleep(500, 1000);
            // Confirm discard if prompted
            const discardBtn = await page.$('button:has-text("Discard"), button[data-control-name="discard_application"]');
            if (discardBtn) await discardBtn.click();
          }
        } catch (_) {
          // Ignore cleanup errors
        }

        await sleep(2000, 4000);

        // Check for CAPTCHA after error
        if (await isCaptchaPage(page)) {
          logger.error({ platform: 'linkedin' }, 'CAPTCHA detected — stopping LinkedIn');
          return { applied, skipped, errors };
        }
      }
    }

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
          const newCards = await page.$$('.job-card-container, .jobs-search-results__list-item');
          if (newCards.length <= jobCards.length) {
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
