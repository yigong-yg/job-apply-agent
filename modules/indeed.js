'use strict';

/**
 * Indeed Apply Module
 *
 * Indeed job cards use a "data-jk" attribute as the unique job key.
 * The "Easily apply" badge identifies Indeed-hosted apply flows (as opposed
 * to external ATS redirects).
 *
 * Key quirks:
 * - After clicking Apply, check if the URL stays on indeed.com (internal) vs
 *   redirects to a company career site (external — skip these)
 * - Indeed's layout is a split-view: job list on the left, detail on the right
 * - The apply form loads in an overlay/modal within the detail panel
 * - Indeed may show a "We noticed you already applied" interstitial
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
    const dir = path.join(process.cwd(), 'logs', 'errors');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const fname = `${today}-${platform}-${(jobId || 'unknown').replace(/[^a-z0-9]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(dir, fname), fullPage: false });
  } catch (_) {}
}

/**
 * Check if Indeed is showing a bot-detection or unusual-activity page.
 */
async function isBotDetected(page) {
  try {
    const content = await page.content();
    return (
      content.includes('unusual activity') ||
      content.includes('security check') ||
      content.includes('Please verify') ||
      (await page.$('iframe[src*="recaptcha"]')) !== null
    );
  } catch (_) {
    return false;
  }
}

/**
 * Extract the Indeed job key from a job card.
 * Indeed uses data-jk="<jobKey>" on each job card.
 */
async function extractIndeedJobId(card) {
  // Primary: data-jk attribute (job key)
  const jk = await card.getAttribute('data-jk');
  if (jk) return jk;

  // Fallback: find link containing jobkey= parameter
  const link = await card.$('a[href*="jk="]');
  if (link) {
    const href = await link.getAttribute('href');
    const match = href.match(/jk=([a-z0-9]+)/i);
    if (match) return match[1];
  }

  return null;
}

/**
 * Check if the current page is still on indeed.com.
 * Used after clicking Apply to detect external redirects.
 */
function isIndeedDomain(url) {
  return url.includes('indeed.com') || url.includes('smartapply.indeed.com');
}

/**
 * Handle a single step of the Indeed apply form.
 * Returns 'next', 'submitted', or 'error'.
 */
async function handleIndeedStep(page, defaultAnswers, config, logger, jobId, dryRun) {
  await sleep(800, 1500);

  const { filledCount, unfilledFields } = await fillForm(
    page,
    defaultAnswers,
    config,
    logger,
    'indeed',
    jobId
  );

  for (const field of unfilledFields) {
    recordUnfilledField({ platform: 'indeed', jobId, fieldLabel: field.fieldLabel, fieldType: field.fieldType });
  }

  logger.debug({ jobId, filledCount, unmatched: unfilledFields.length }, 'Filled Indeed step');

  await sleep(500, 1000);

  // Indeed's step navigation buttons
  const buttonSelectors = [
    { selector: 'button:has-text("Submit your application")', action: 'submit' },
    { selector: 'button:has-text("Submit application")', action: 'submit' },
    { selector: 'button:has-text("Apply")', action: 'submit' },
    { selector: 'button:has-text("Continue")', action: 'next' },
    { selector: 'button:has-text("Next")', action: 'next' },
  ];

  for (const { selector, action } of buttonSelectors) {
    const btn = await page.$(selector);
    if (btn && await btn.isVisible()) {
      if (action === 'submit') {
        if (dryRun) {
          await screenshotError(page, 'indeed', `dryrun-${jobId}`, config);
          logger.info({ jobId }, '[DRY RUN] Would submit Indeed application');
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

  return 'error';
}

/**
 * Main Indeed Apply function.
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
async function applyIndeed(page, config, defaultAnswers, state, runId, logger, dryRun = false) {
  const platformConfig = config.platforms.indeed;
  const maxApplications = platformConfig.maxApplicationsPerRun;
  const { minDelayBetweenApplications, maxDelayBetweenApplications } = config.behavior;

  const maxRetries = config.behavior?.maxRetries ?? 0;
  const retryAttempts = new Map(); // jobId → number of retries made

  let applied = 0;
  let skipped = 0;
  let errors = 0;

  logger.info({ platform: 'indeed', searchUrl: platformConfig.searchUrl }, 'Navigating to Indeed search');

  // The search URL includes Indeed Apply filter: sc=0kf%3Aattr(DSQF7)%3B
  await page.goto(platformConfig.searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000, 4000);

  if (await isBotDetected(page)) {
    logger.error({ platform: 'indeed' }, 'Bot detection triggered. Stopping Indeed.');
    state.recordApplication({
      platform: 'indeed', jobId: 'captcha_detected',
      status: 'captcha_blocked', errorMessage: 'Bot/CAPTCHA detection triggered — platform stopped', runId,
    });
    return { applied, skipped, errors };
  }

  const searchUrl = platformConfig.searchUrl;
  let currentPage = 1;
  let pageHasMoreJobs = true;

  while (applied < maxApplications && pageHasMoreJobs) {
    // Wait for job cards container
    try {
      await page.waitForSelector('#mosaic-provider-jobcards, .jobsearch-ResultsList', {
        timeout: SELECTOR_TIMEOUT,
      });
    } catch (_) {
      logger.warn({ platform: 'indeed' }, 'Job cards container not found');
      break;
    }

    await sleep(1000, 2000);

    // Get job cards — Indeed uses li elements with data-jk
    const jobCards = await page.$$('li[data-jk], .job_seen_beacon, .slider_item');
    logger.info({ platform: 'indeed', cardCount: jobCards.length, page: currentPage }, 'Found job cards');

    const cardsToProcess = [...jobCards];

    while (cardsToProcess.length > 0 && applied < maxApplications) {
      const card = cardsToProcess.shift();

      let jobId = null;
      let jobTitle = null;
      let company = null;
      let jobUrl = null;

      try {
        jobId = await extractIndeedJobId(card);
        if (!jobId) {
          skipped++;
          continue;
        }

        if (state.hasApplied('indeed', jobId)) {
          logger.debug({ jobId }, 'Already applied — skipping');
          state.recordApplication({ platform: 'indeed', jobId, status: 'already_applied', runId });
          skipped++;
          continue;
        }

        // Extract job info from the card
        const titleEl = await card.$('.jobTitle a, h2 a, [data-testid="job-title"]');
        if (titleEl) {
          jobTitle = (await titleEl.innerText()).trim();
          const href = await titleEl.getAttribute('href');
          if (href) jobUrl = href.startsWith('http') ? href : `https://www.indeed.com${href}`;
        }
        const companyEl = await card.$('[data-testid="company-name"], .companyName');
        if (companyEl) company = (await companyEl.innerText()).trim();

        // Check if card has "Easily apply" badge — this is our quality filter
        const easyApplyBadge = await card.$(
          '.easily-apply-badge, span:has-text("Easily apply"), [data-testid="attr-DSQF7"]'
        );

        if (!easyApplyBadge) {
          // No "Easily apply" badge — this is likely an external redirect
          logger.debug({ jobId, jobTitle }, 'No "Easily apply" badge — skipping');
          state.recordApplication({
            platform: 'indeed', jobId, jobTitle, company, jobUrl,
            status: 'skipped', errorMessage: 'no_easy_apply_badge', runId,
          });
          skipped++;
          continue;
        }

        // Click the job card to load the detail panel (right side)
        await card.click();
        await sleep(1500, 2500);

        // Wait for detail panel to load
        await page.waitForSelector(
          '#jobDetailPage, .jobsearch-JobComponent, [data-testid="job-detail"]',
          { timeout: SELECTOR_TIMEOUT }
        );

        jobUrl = page.url();

        // Find the Apply/Easily Apply button in the detail panel
        const applyBtn = await page.$(
          '[data-testid="indeedApplyButton"], button:has-text("Apply now"), a:has-text("Apply now"), button:has-text("Easily apply")'
        );

        if (!applyBtn || !(await applyBtn.isVisible())) {
          logger.debug({ jobId, jobTitle }, 'Apply button not visible in detail panel');
          skipped++;
          continue;
        }

        // Record the URL before clicking — we'll check after to detect external redirect
        const urlBeforeClick = page.url();

        logger.info({ jobId, jobTitle, company }, 'Clicking Indeed apply button');
        await applyBtn.click();
        await sleep(2000, 3000);

        // Check if we stayed on Indeed's domain
        const urlAfterClick = page.url();
        if (!isIndeedDomain(urlAfterClick)) {
          logger.debug({ jobId, jobTitle, url: urlAfterClick }, 'Redirected to external site — skipping');
          state.recordApplication({
            platform: 'indeed', jobId, jobTitle, company, jobUrl,
            status: 'skipped', errorMessage: 'external_redirect', runId,
          });
          skipped++;
          // Navigate back to search results
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
          await sleep(2000, 3000);
          continue;
        }

        // Check for "already applied" interstitial
        const alreadyApplied = await page.$('text="We noticed you already applied"');
        if (alreadyApplied) {
          const closeBtn = await page.$('button:has-text("Close"), button:has-text("OK"), [data-testid="modal-close"]');
          if (closeBtn) await closeBtn.click();
          state.recordApplication({
            platform: 'indeed', jobId, jobTitle, company, jobUrl,
            status: 'already_applied', runId,
          });
          skipped++;
          continue;
        }

        // Wait for the Indeed apply form/iframe to load
        // Indeed sometimes loads the form in an iframe
        await page.waitForSelector(
          '.ia-BasePage, [data-testid="ia-page"], .indeed-apply-widget, iframe[id*="indeed-apply"]',
          { timeout: SELECTOR_TIMEOUT }
        ).catch(() => null);

        await sleep(1000, 2000);

        if (await isBotDetected(page)) {
          logger.error({ platform: 'indeed' }, 'Bot detection triggered during apply flow. Stopping.');
          state.recordApplication({
            platform: 'indeed', jobId: 'captcha_detected',
            status: 'captcha_blocked', errorMessage: 'Bot/CAPTCHA detection triggered — platform stopped', runId,
          });
          return { applied, skipped, errors };
        }

        // Check if apply form loaded in an iframe
        const applyIframe = await page.$('iframe[id*="indeed-apply"], iframe[src*="smartapply"]');
        let applyPage = page;
        if (applyIframe) {
          // Switch to the iframe's content frame
          const frame = await applyIframe.contentFrame();
          if (frame) {
            applyPage = frame;
            await sleep(1000, 2000);
          }
        }

        // Multi-step form navigation
        let stepCount = 0;
        let formComplete = false;
        const MAX_STEPS = 8;

        while (!formComplete && stepCount < MAX_STEPS) {
          stepCount++;
          const result = await handleIndeedStep(applyPage, defaultAnswers, config, logger, jobId, dryRun);

          if (result === 'submitted') {
            formComplete = true;

            // Wait for confirmation
            await page.waitForSelector(
              'text="Your application has been submitted", text="application submitted", [data-testid="postApplyPage"]',
              { timeout: 10000 }
            ).catch(() => null);

            logger.info({ jobId, jobTitle, company, steps: stepCount }, 'Indeed application submitted');
            state.recordApplication({
              platform: 'indeed', jobId, jobTitle, company, jobUrl,
              status: dryRun ? 'dry_run' : 'submitted', runId,
            });
            applied++;

          } else if (result === 'error') {
            throw new Error(`Could not navigate Indeed form step ${stepCount}`);
          }
        }

        if (!formComplete) {
          throw new Error(`Indeed form exceeded ${MAX_STEPS} steps`);
        }

        await sleep(minDelayBetweenApplications, maxDelayBetweenApplications);

        // Navigate back to search results page
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(2000, 3000);

      } catch (err) {
        // Return to search results
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (_) {}

        await sleep(2000, 4000);

        // Check for bot detection before deciding whether to retry (PRD §8.2)
        if (await isBotDetected(page)) {
          logger.error({ platform: 'indeed' }, 'Bot detection after error — stopping Indeed');
          state.recordApplication({
            platform: 'indeed', jobId: 'captcha_detected',
            status: 'captcha_blocked', errorMessage: 'Bot/CAPTCHA detection triggered — platform stopped', runId,
          });
          return { applied, skipped, errors };
        }

        // Retry transient errors up to maxRetries times
        const attemptsMade = (retryAttempts.get(jobId ?? '') || 0) + 1;
        if (jobId && attemptsMade <= maxRetries) {
          retryAttempts.set(jobId, attemptsMade);
          logger.warn({ platform: 'indeed', jobId, attempt: attemptsMade, error: err.message }, 'Transient error — queuing retry');
          cardsToProcess.push(card);
        } else {
          logger.error({ platform: 'indeed', jobId, jobTitle, error: err.message }, 'Application error');
          errors++;
          await screenshotError(page, 'indeed', jobId, config);
          state.recordApplication({
            platform: 'indeed', jobId, jobTitle, company, jobUrl,
            status: 'error', errorMessage: err.message, runId,
          });
        }
      }
    }

    // Pagination: Indeed uses page links at the bottom
    if (applied < maxApplications) {
      try {
        const nextPageLink = await page.$(
          `a[aria-label="Page ${currentPage + 1}"], a[data-testid="pagination-page-next"]`
        );
        if (nextPageLink && await nextPageLink.isVisible()) {
          currentPage++;
          await nextPageLink.click();
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

module.exports = { applyIndeed };
