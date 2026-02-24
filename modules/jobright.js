'use strict';

/**
 * Jobright Quick Apply Module
 *
 * Jobright is a newer platform with a personalized job feed.
 * Key characteristics:
 * - Uses INFINITE SCROLL for pagination (scroll down to load more jobs)
 * - Some jobs are internal (stay on jobright.ai) — these are in scope
 * - Some jobs redirect to external company sites — skip these
 * - Resume is auto-attached from the Jobright profile
 * - Sessions expire ~7 days — check frequently
 *
 * The apply flow is simpler than LinkedIn:
 * 1. Click Apply on a job listing
 * 2. Check if we stayed on jobright.ai
 * 3. If internal apply: fill any fields, click Submit
 * 4. Record result
 */

const path = require('path');
const fs = require('fs');
const { sleep, scrollLikeHuman } = require('../lib/humanize');
const { fillForm } = require('../lib/form-filler');
const { recordUnfilledField } = require('../lib/state');

const SELECTOR_TIMEOUT = 10000;

async function screenshotError(page, platform, jobId, config) {
  if (!config.behavior?.screenshotOnError) return;
  try {
    const dir = path.join(process.cwd(), 'logs', 'errors');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const fname = `${today}-${platform}-${(jobId || 'unknown').replace(/[^a-z0-9]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(dir, fname), fullPage: false });
  } catch (_) {}
}

/**
 * Check if we're still on the jobright.ai domain.
 */
function isJobrightDomain(url) {
  return url.includes('jobright.ai');
}

/**
 * Detect Cloudflare challenge or other security check pages on Jobright.
 * PRD §8.2: "Jobright: Any challenge page" must trigger platform stop.
 * @returns {Promise<boolean>}
 */
async function isChallengedPage(page) {
  try {
    const content = await page.content();
    return (
      content.includes('Checking your browser') ||
      content.includes('Just a moment') ||
      content.includes('security check') ||
      content.includes('cf-browser-verification') ||
      (await page.$('iframe[src*="captcha"]')) !== null ||
      (await page.$('iframe[src*="challenge"]')) !== null
    );
  } catch (_) {
    return false;
  }
}

/**
 * Extract job ID from a Jobright listing.
 * Jobright uses data attributes or URL slugs.
 */
async function extractJobrightJobId(card) {
  // Try data-job-id
  const dataId = await card.getAttribute('data-job-id') ||
                 await card.getAttribute('data-id') ||
                 await card.getAttribute('id');
  if (dataId && dataId !== 'undefined') return dataId;

  // Try to find a link
  const link = await card.$('a[href*="/job/"]');
  if (link) {
    const href = await link.getAttribute('href');
    const match = href.match(/\/job\/([^?#/]+)/);
    if (match) return match[1];
  }

  return null;
}

/**
 * Scroll the job feed to load more jobs via infinite scroll.
 * Jobright uses virtualized infinite scroll — we need to scroll past
 * loaded content to trigger new job loads.
 *
 * @returns {Promise<number>} - number of job cards after scrolling
 */
async function scrollToLoadMoreJobs(page, currentCount) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(2000, 3500);

  const newCards = await page.$$('[data-testid="job-card"], .job-card, [class*="JobCard"]');
  return newCards.length;
}

/**
 * Main Jobright Quick Apply function.
 *
 * @param {import('playwright').Page} page
 * @param {object} config
 * @param {object} defaultAnswers
 * @param {object} state
 * @param {string} runId
 * @param {object} logger
 * @param {boolean} [dryRun=false]
 * @returns {Promise<{ applied: number, skipped: number, errors: number }>}
 */
async function applyJobright(page, config, defaultAnswers, state, runId, logger, dryRun = false) {
  const platformConfig = config.platforms.jobright;
  const maxApplications = platformConfig.maxApplicationsPerRun;
  const { minDelayBetweenApplications, maxDelayBetweenApplications } = config.behavior;

  let applied = 0;
  let skipped = 0;
  let errors = 0;
  let processedJobIds = new Set(); // Track processed jobs in this run to avoid re-processing

  logger.info({ platform: 'jobright', searchUrl: platformConfig.searchUrl }, 'Navigating to Jobright jobs');

  await page.goto(platformConfig.searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000, 4000);

  // Check for login wall (Jobright sessions expire quickly)
  const loginModal = await page.$('.login-modal, [data-testid="login-modal"], [class*="loginModal"]');
  const currentUrl = page.url();
  if (loginModal || !isJobrightDomain(currentUrl) || currentUrl.includes('/login')) {
    logger.error({ platform: 'jobright' }, 'Jobright session expired or login required. Stopping.');
    return { applied, skipped, errors };
  }

  // Check for Cloudflare/security challenge page (PRD §8.2)
  if (await isChallengedPage(page)) {
    logger.error({ platform: 'jobright' }, 'Challenge/security check detected. Stopping Jobright.');
    state.recordApplication({
      platform: 'jobright', jobId: 'captcha_detected',
      status: 'captcha_blocked', errorMessage: 'Challenge page detected — platform stopped', runId,
    });
    return { applied, skipped, errors };
  }

  // Wait for the job feed to load
  try {
    await page.waitForSelector(
      '[data-testid="job-card"], .job-card, [class*="JobCard"], .job-list-item',
      { timeout: SELECTOR_TIMEOUT }
    );
  } catch (_) {
    logger.warn({ platform: 'jobright' }, 'Job feed not found — possible page structure change');
    return { applied, skipped, errors };
  }

  await sleep(1000, 2000);

  let noNewJobsCount = 0;
  const MAX_NO_NEW_JOBS = 3; // Stop if we can't load new jobs after 3 tries

  while (applied < maxApplications) {
    // Get all currently loaded job cards
    const allCards = await page.$$(
      '[data-testid="job-card"], .job-card, [class*="JobCard"], .job-list-item'
    );

    // Find unprocessed cards
    const unprocessedCards = [];
    for (const card of allCards) {
      const jobId = await extractJobrightJobId(card);
      if (jobId && !processedJobIds.has(jobId)) {
        unprocessedCards.push({ card, jobId });
      }
    }

    if (unprocessedCards.length === 0) {
      // No unprocessed cards — try to load more via infinite scroll
      const prevCount = allCards.length;
      const newCount = await scrollToLoadMoreJobs(page, prevCount);

      if (newCount <= prevCount) {
        noNewJobsCount++;
        if (noNewJobsCount >= MAX_NO_NEW_JOBS) {
          logger.info({ platform: 'jobright' }, 'No more jobs to load — reached end of feed');
          break;
        }
      } else {
        noNewJobsCount = 0;
      }
      continue;
    }

    noNewJobsCount = 0;

    for (const { card, jobId } of unprocessedCards) {
      if (applied >= maxApplications) break;

      processedJobIds.add(jobId);

      let jobTitle = null;
      let company = null;
      let jobUrl = null;

      try {
        // Mark as processed first to avoid re-processing on errors
        if (state.hasApplied('jobright', jobId)) {
          logger.debug({ jobId }, 'Already applied — skipping');
          state.recordApplication({ platform: 'jobright', jobId, status: 'already_applied', runId });
          skipped++;
          continue;
        }

        // Extract job info from the card
        const titleEl = await card.$('[class*="jobTitle"], [data-testid="job-title"], h3, h2');
        if (titleEl) jobTitle = (await titleEl.innerText()).trim();
        const companyEl = await card.$('[class*="companyName"], [data-testid="company-name"]');
        if (companyEl) company = (await companyEl.innerText()).trim();

        // Click the job card to open the detail view
        await card.click();
        await sleep(1500, 2500);

        jobUrl = page.url();

        // Check if we're still on Jobright (some cards link to external sites)
        if (!isJobrightDomain(page.url())) {
          logger.debug({ jobId, jobTitle, url: page.url() }, 'Card opened external site — skipping');
          state.recordApplication({
            platform: 'jobright', jobId, jobTitle, company, jobUrl,
            status: 'skipped', errorMessage: 'external_redirect', runId,
          });
          skipped++;
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await sleep(1000, 2000);
          continue;
        }

        // Wait for job detail to load
        await page.waitForSelector(
          '[class*="jobDetail"], [data-testid="job-detail"], .job-description',
          { timeout: SELECTOR_TIMEOUT }
        ).catch(() => null);

        // Find the Apply button
        const applyBtn = await page.$(
          'button:has-text("Apply"), button:has-text("Quick Apply"), [data-testid="apply-button"], [class*="applyButton"]'
        );

        if (!applyBtn || !(await applyBtn.isVisible())) {
          logger.debug({ jobId, jobTitle }, 'No Apply button visible — skipping');
          skipped++;
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await sleep(1000, 2000);
          continue;
        }

        // Check button text — skip if it says "Applied" or "Already Applied"
        const btnText = (await applyBtn.innerText()).toLowerCase();
        if (btnText.includes('applied') && !btnText.includes('quick')) {
          state.recordApplication({
            platform: 'jobright', jobId, jobTitle, company, jobUrl,
            status: 'already_applied', runId,
          });
          skipped++;
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await sleep(1000, 2000);
          continue;
        }

        logger.info({ jobId, jobTitle, company }, 'Clicking Jobright apply button');
        await applyBtn.click();
        await sleep(1500, 2500);

        // Check if we got redirected to an external site after clicking
        const urlAfterClick = page.url();
        if (!isJobrightDomain(urlAfterClick)) {
          logger.debug({ jobId, jobTitle, url: urlAfterClick }, 'Apply redirected to external — skipping');
          state.recordApplication({
            platform: 'jobright', jobId, jobTitle, company, jobUrl,
            status: 'skipped', errorMessage: 'external_redirect', runId,
          });
          skipped++;
          await page.goto(platformConfig.searchUrl, { waitUntil: 'domcontentloaded' });
          await sleep(2000, 3000);
          continue;
        }

        // Jobright internal apply — wait for the apply form/modal
        const applyForm = await page.waitForSelector(
          '[data-testid="apply-form"], .apply-form, [class*="applyForm"], [role="dialog"]',
          { timeout: SELECTOR_TIMEOUT }
        ).catch(() => null);

        // Fill any fields in the apply form
        const { filledCount, unfilledFields } = await fillForm(
          page,
          defaultAnswers,
          config,
          logger,
          'jobright',
          jobId
        );

        for (const field of unfilledFields) {
          recordUnfilledField({
            platform: 'jobright', jobId,
            fieldLabel: field.fieldLabel, fieldType: field.fieldType,
          });
        }

        logger.debug({ jobId, filledCount, unmatched: unfilledFields.length }, 'Filled Jobright form');

        await sleep(500, 1000);

        // Find and click submit
        const submitBtn = await page.$(
          'button:has-text("Submit"), button:has-text("Submit Application"), button:has-text("Apply Now"), [data-testid="submit-button"]'
        );

        if (!submitBtn || !(await submitBtn.isVisible())) {
          // Jobright Quick Apply might auto-submit with just the Apply button click
          // Check if confirmation is already showing
          const confirmed = await page.$(
            'text="Application submitted", text="Successfully applied", [class*="success"], [data-testid="success"]'
          );
          if (confirmed) {
            logger.info({ jobId, jobTitle, company }, 'Jobright application auto-submitted');
            state.recordApplication({
              platform: 'jobright', jobId, jobTitle, company, jobUrl,
              status: dryRun ? 'dry_run' : 'submitted', runId,
            });
            applied++;
          } else {
            throw new Error('Submit button not found and no auto-submission detected');
          }
        } else {
          if (dryRun) {
            await screenshotError(page, 'jobright', `dryrun-${jobId}`, config);
            logger.info({ jobId }, '[DRY RUN] Would submit Jobright application');
            const closeBtn = await page.$('button[aria-label="Close"], button:has-text("Cancel")');
            if (closeBtn) await closeBtn.click();
            state.recordApplication({
              platform: 'jobright', jobId, jobTitle, company, jobUrl,
              status: 'dry_run', runId,
            });
          } else {
            await submitBtn.click();
            await sleep(1500, 2500);

            // Wait for success indicator
            await page.waitForSelector(
              'text="Application submitted", text="Successfully applied", [class*="success"]',
              { timeout: 10000 }
            ).catch(() => null);

            logger.info({ jobId, jobTitle, company }, 'Jobright application submitted');
            state.recordApplication({
              platform: 'jobright', jobId, jobTitle, company, jobUrl,
              status: 'submitted', runId,
            });
          }
          applied++;
        }

        await sleep(minDelayBetweenApplications, maxDelayBetweenApplications);

        // Navigate back to the job feed
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(async () => {
          await page.goto(platformConfig.searchUrl, { waitUntil: 'domcontentloaded' });
        });
        await sleep(1500, 2500);

      } catch (err) {
        logger.error({ platform: 'jobright', jobId, jobTitle, error: err.message }, 'Application error');
        errors++;
        await screenshotError(page, 'jobright', jobId, config);

        state.recordApplication({
          platform: 'jobright', jobId, jobTitle, company, jobUrl,
          status: 'error', errorMessage: err.message, runId,
        });

        // Return to job feed
        try {
          if (!isJobrightDomain(page.url())) {
            await page.goto(platformConfig.searchUrl, { waitUntil: 'domcontentloaded' });
          }
        } catch (_) {}

        await sleep(2000, 4000);

        // Check for challenge page after error (PRD §8.2)
        if (await isChallengedPage(page)) {
          logger.error({ platform: 'jobright' }, 'Challenge detected — stopping Jobright');
          state.recordApplication({
            platform: 'jobright', jobId: 'captcha_detected',
            status: 'captcha_blocked', errorMessage: 'Challenge page detected — platform stopped', runId,
          });
          return { applied, skipped, errors };
        }
      }
    }
  }

  return { applied, skipped, errors };
}

module.exports = { applyJobright };
