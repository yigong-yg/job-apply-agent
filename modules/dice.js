'use strict';

/**
 * Dice Easy Apply Module
 *
 * Dice's flow differs from LinkedIn in two key ways:
 * 1. Clicking a job card opens a FULL PAGE detail view (not a side panel)
 * 2. Easy Apply is a single-screen overlay modal (simpler than LinkedIn's multi-step)
 *
 * The job ID is extracted from the job detail page URL or card links.
 * After applying (or skipping), we navigate BACK to the search results.
 */

const path = require('path');
const fs = require('fs');
const { sleep } = require('../lib/humanize');
const { fillForm } = require('../lib/form-filler');
const { recordUnfilledField } = require('../lib/state');

const SELECTOR_TIMEOUT = 10000;

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

/**
 * Detect Cloudflare challenge or other blocking pages on Dice.
 */
async function isBlockedPage(page) {
  try {
    const content = await page.content();
    return content.includes('Checking your browser') ||
           content.includes('Just a moment') ||
           content.includes('cf-browser-verification') ||
           content.includes('DDoS protection');
  } catch (_) {
    return false;
  }
}

/**
 * Extract job ID from a Dice job card or URL.
 * Dice URLs look like: /job-detail/abc-123-def
 */
async function extractDiceJobId(card) {
  const link = await card.$('a[href*="/job-detail/"]');
  if (link) {
    const href = await link.getAttribute('href');
    const match = href.match(/\/job-detail\/([^?#/]+)/);
    if (match) return match[1];
  }

  // Fallback: try data attributes
  const dataId = await card.getAttribute('data-cy-job-id') ||
                 await card.getAttribute('data-job-id') ||
                 await card.getAttribute('id');
  return dataId || null;
}

/**
 * Get the job detail URL from a card.
 */
async function getJobDetailUrl(card, baseUrl = 'https://www.dice.com') {
  const link = await card.$('a[href*="/job-detail/"]');
  if (link) {
    const href = await link.getAttribute('href');
    return href.startsWith('http') ? href : `${baseUrl}${href}`;
  }
  return null;
}

/**
 * Main Dice Easy Apply function.
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
/**
 * Build a Dice search URL dynamically from config.search.keywords.
 */
function buildSearchUrl(config) {
  const keywords = (config.search?.keywords || ['data scientist']).join(' OR ');
  const encoded = encodeURIComponent(keywords);
  const location = encodeURIComponent(config.search?.location || 'United States');
  return `https://www.dice.com/jobs?q=${encoded}&location=${location}&postedDate=SEVEN`;
}

async function applyDice(page, config, defaultAnswers, state, runId, logger, dryRun = false) {
  const platformConfig = config.platforms.dice;
  const maxApplications = platformConfig.maxApplicationsPerRun;
  const { minDelayBetweenApplications, maxDelayBetweenApplications } = config.behavior;

  const maxRetries = config.behavior?.maxRetries ?? 0;
  const retryAttempts = new Map(); // jobId → number of retries made

  let applied = 0;
  let skipped = 0;
  let errors = 0;

  const searchUrl = buildSearchUrl(config);
  logger.info({ platform: 'dice', searchUrl }, 'Navigating to Dice search');

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000, 4000);

  if (await isBlockedPage(page)) {
    logger.error({ platform: 'dice' }, 'Cloudflare block detected. Stopping Dice.');
    state.recordApplication({
      platform: 'dice', jobId: 'captcha_detected',
      status: 'captcha_blocked', errorMessage: 'Cloudflare/bot block detected — platform stopped', runId,
    });
    return { applied, skipped, errors };
  }
  let currentPage = 1;
  let pageHasMoreJobs = true;

  while (applied < maxApplications && pageHasMoreJobs) {
    // Wait for job cards to load
    // Dice is React SPA — waitForSelector auto-waits for React to render
    try {
      await page.waitForSelector(
        'dhi-search-cards-widget, .search-result-job-card, [data-cy="search-card"]',
        { timeout: 15000 }
      );
    } catch (_) {
      logger.warn({ platform: 'dice' }, 'Job cards not found — may have reached end of results');
      break;
    }

    await sleep(1000, 2000); // Let React finish rendering

    const jobCards = await page.$$(
      '.search-result-job-card, [data-cy="search-card"], dhi-search-card'
    );
    logger.info({ platform: 'dice', cardCount: jobCards.length, page: currentPage }, 'Found job cards');

    const cardsToProcess = [...jobCards];

    while (cardsToProcess.length > 0 && applied < maxApplications) {
      const card = cardsToProcess.shift();

      let jobId = null;
      let jobTitle = null;
      let company = null;
      let jobUrl = null;

      try {
        jobId = await extractDiceJobId(card);
        if (!jobId) {
          skipped++;
          continue;
        }

        if (state.hasApplied('dice', jobId)) {
          logger.debug({ jobId }, 'Already applied — skipping');
          state.recordApplication({ platform: 'dice', jobId, status: 'already_applied', runId });
          skipped++;
          continue;
        }

        jobUrl = await getJobDetailUrl(card);
        if (!jobUrl) {
          skipped++;
          continue;
        }

        // Extract basic info from card before navigating
        const titleEl = await card.$('[data-cy="card-title-link"], .job-title, h5');
        if (titleEl) jobTitle = (await titleEl.innerText()).trim();
        const companyEl = await card.$('[data-cy="employer-name"], .company-name');
        if (companyEl) company = (await companyEl.innerText()).trim();

        // Navigate to the full job detail page (Dice opens new page, not side panel)
        logger.info({ jobId, jobTitle, company }, 'Navigating to Dice job detail');
        await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(1500, 3000);

        if (await isBlockedPage(page)) {
          logger.error({ platform: 'dice' }, 'Blocked page detected mid-run. Stopping.');
          state.recordApplication({
            platform: 'dice', jobId: 'captcha_detected',
            status: 'captcha_blocked', errorMessage: 'Cloudflare/bot block detected — platform stopped', runId,
          });
          return { applied, skipped, errors };
        }

        // Check for "Complete your profile" interstitial — if shown, user must fix manually
        const profileIncomplete = await page.$('text="Complete your profile", text="complete your profile"');
        if (profileIncomplete) {
          logger.warn({ jobId }, 'Dice showing "Complete your profile" — skipping job (fix profile manually)');
          state.recordApplication({
            platform: 'dice', jobId, jobTitle, company, jobUrl,
            status: 'skipped', errorMessage: 'incomplete_profile', runId,
          });
          skipped++;
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await sleep(1000, 2000);
          continue;
        }

        // Look for the "Easy Apply" button on the detail page
        // Dice uses React, so button text/classes may vary
        const easyApplyBtn = await page.$(
          'button:has-text("Easy Apply"), [data-cy="apply-button-top"], [data-testid="easy-apply-button"]'
        );

        if (!easyApplyBtn || !(await easyApplyBtn.isVisible())) {
          // Only "Apply" button present — external redirect
          logger.debug({ jobId, jobTitle }, 'No Easy Apply button on Dice job — skipping (external)');
          state.recordApplication({
            platform: 'dice', jobId, jobTitle, company, jobUrl,
            status: 'skipped', errorMessage: 'external_apply', runId,
          });
          skipped++;
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await sleep(1000, 2000);
          continue;
        }

        // Check button text — Dice sometimes shows "Applied" if already done
        const btnText = (await easyApplyBtn.innerText()).toLowerCase();
        if (btnText.includes('applied')) {
          state.recordApplication({
            platform: 'dice', jobId, jobTitle, company, jobUrl,
            status: 'already_applied', runId,
          });
          skipped++;
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await sleep(1000, 2000);
          continue;
        }

        // Click Easy Apply to open the modal overlay
        logger.info({ jobId, jobTitle, company }, 'Opening Dice Easy Apply modal');
        await easyApplyBtn.click();
        await sleep(1500, 2500);

        // Wait for the modal to appear
        // Dice uses an overlay modal with varying selectors (React component names change)
        const modal = await page.waitForSelector(
          '.apply-modal, [data-testid="apply-modal"], .easy-apply-modal, dialog[open], [role="dialog"]',
          { timeout: SELECTOR_TIMEOUT }
        ).catch(() => null);

        if (!modal) {
          // Modal didn't open — Dice job probably redirected externally
          const currentUrl = page.url();
          if (!currentUrl.includes('dice.com')) {
            logger.debug({ jobId }, 'Dice redirected to external site — skipping');
            state.recordApplication({
              platform: 'dice', jobId, jobTitle, company, jobUrl,
              status: 'skipped', errorMessage: 'external_redirect', runId,
            });
            skipped++;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
            await sleep(2000, 3000);
            continue;
          }
          throw new Error('Easy Apply modal did not open within timeout');
        }

        // Fill all fields in the single-screen Dice modal
        const { filledCount, unfilledFields } = await fillForm(
          page,
          defaultAnswers,
          config,
          logger,
          'dice',
          jobId
        );

        for (const field of unfilledFields) {
          recordUnfilledField({ platform: 'dice', jobId, fieldLabel: field.fieldLabel, fieldType: field.fieldType });
        }

        logger.debug({ jobId, filledCount, unmatched: unfilledFields.length }, 'Filled Dice modal');

        await sleep(500, 1000);

        // Find and click the submit button in the modal
        const submitBtn = await page.$(
          'button:has-text("Submit"), button:has-text("Apply"), [data-testid="submit-apply"]'
        );

        if (!submitBtn || !(await submitBtn.isVisible())) {
          throw new Error('Submit button not found in Dice modal');
        }

        if (dryRun) {
          await screenshotError(page, 'dice', `dryrun-${jobId}`, config);
          logger.info({ jobId }, '[DRY RUN] Would submit Dice application — screenshot taken');
          // Close modal without submitting
          const closeBtn = await page.$('button[aria-label="Close"], button:has-text("Cancel"), [data-testid="close-modal"]');
          if (closeBtn) await closeBtn.click();
          state.recordApplication({
            platform: 'dice', jobId, jobTitle, company, jobUrl,
            status: 'dry_run', runId,
          });
        } else {
          await submitBtn.click();
          await sleep(1500, 2500);

          // Wait for confirmation
          await page.waitForSelector(
            'text="Application Submitted", text="Successfully applied", text="application submitted"',
            { timeout: 10000 }
          ).catch(() => null);

          logger.info({ jobId, jobTitle, company }, 'Dice application submitted');
          state.recordApplication({
            platform: 'dice', jobId, jobTitle, company, jobUrl,
            status: 'submitted', runId,
          });
        }

        applied++;
        await sleep(minDelayBetweenApplications, maxDelayBetweenApplications);

        // Navigate back to search results
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(2000, 3000);

      } catch (err) {
        // Try to navigate back to search results
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/jobs')) {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
        } catch (_) {}

        await sleep(2000, 4000);

        // Check for block page before deciding whether to retry (PRD §8.2)
        if (await isBlockedPage(page)) {
          logger.error({ platform: 'dice' }, 'Block page detected after error — stopping Dice');
          state.recordApplication({
            platform: 'dice', jobId: 'captcha_detected',
            status: 'captcha_blocked', errorMessage: 'Cloudflare/bot block detected — platform stopped', runId,
          });
          return { applied, skipped, errors };
        }

        // Retry transient errors up to maxRetries times
        const attemptsMade = (retryAttempts.get(jobId ?? '') || 0) + 1;
        if (jobId && attemptsMade <= maxRetries) {
          retryAttempts.set(jobId, attemptsMade);
          logger.warn({ platform: 'dice', jobId, attempt: attemptsMade, error: err.message }, 'Transient error — queuing retry');
          cardsToProcess.push(card);
        } else {
          logger.error({ platform: 'dice', jobId, jobTitle, error: err.message }, 'Application error');
          errors++;
          await screenshotError(page, 'dice', jobId, config);
          state.recordApplication({
            platform: 'dice', jobId, jobTitle, company, jobUrl,
            status: 'error', errorMessage: err.message, runId,
          });
        }
      }
    }

    // Pagination: Dice uses numbered pages at the bottom
    if (applied < maxApplications) {
      try {
        const nextBtn = await page.$('a[aria-label="Go to next page"], button[aria-label="Next page"], .pagination-next');
        if (nextBtn && await nextBtn.isVisible()) {
          currentPage++;
          await nextBtn.click();
          await sleep(2000, 4000);
        } else {
          pageHasMoreJobs = false;
        }
      } catch (_) {
        pageHasMoreJobs = false;
      }
    }
  }

  return { applied, skipped, errors };
}

module.exports = { applyDice };
