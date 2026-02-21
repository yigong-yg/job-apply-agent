'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Real Chrome user agent — avoids Playwright's default which is detectable
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Salt Lake City coordinates (for optional geolocation)
const SLC_GEO = { latitude: 40.7608, longitude: -111.891 };

/**
 * Ensure the persistent browser profile directory exists for a platform.
 */
function ensureProfileDir(platform) {
  const dir = path.join(process.cwd(), 'browser-data', platform);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Launch a Playwright browser with a PERSISTENT context for the given platform.
 *
 * Why persistent context?
 * Playwright's persistent context saves cookies, localStorage, and session data
 * between runs — just like a real browser profile. This is how login sessions
 * are preserved: log in once manually via setup.js, and the cookies are reused
 * every subsequent run.
 *
 * @param {string} platform - 'linkedin' | 'indeed' | 'dice' | 'jobright'
 * @param {boolean} [headless=true] - false for manual setup/debugging
 * @returns {Promise<{ context: import('playwright').BrowserContext, page: import('playwright').Page }>}
 */
async function launchForPlatform(platform, headless = true) {
  const profileDir = ensureProfileDir(platform);

  // launchPersistentContext combines browser launch + context creation.
  // The first argument is the directory where the profile is stored.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 800 },
    userAgent: CHROME_USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/Denver',
    // Uncomment to enable geolocation (requires browser permission grant):
    // geolocation: SLC_GEO,
    // permissions: ['geolocation'],
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled', // hides navigator.webdriver
      '--disable-infobars',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Hide automation detection signals via JavaScript injection
  await context.addInitScript(() => {
    // Remove webdriver property that some sites check
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Spoof plugins array to look like real Chrome
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // Spoof languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // Use the first page already created by the persistent context,
  // or open a new one if none exists yet
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  return { context, page };
}

/**
 * Check if the user is still logged in to the given platform.
 * Each platform has a different "authenticated page" to test against.
 *
 * Strategy: navigate to a page that requires login. If we get redirected
 * to a login page, the session has expired.
 *
 * @param {import('playwright').Page} page
 * @param {string} platform
 * @returns {Promise<boolean>}
 */
async function checkLoginStatus(page, platform) {
  const checks = {
    linkedin: {
      url: 'https://www.linkedin.com/feed/',
      // Session expired if we end up on the login page
      expiredIndicator: async (p) => {
        const url = p.url();
        return url.includes('/login') || url.includes('/checkpoint') || url.includes('/authwall');
      },
    },
    indeed: {
      url: 'https://www.indeed.com/account/view',
      expiredIndicator: async (p) => {
        const url = p.url();
        return url.includes('/account/login') || url.includes('/auth');
      },
    },
    dice: {
      url: 'https://www.dice.com/dashboard',
      expiredIndicator: async (p) => {
        const url = p.url();
        return url.includes('/login') || url.includes('/signin');
      },
    },
    jobright: {
      url: 'https://jobright.ai/jobs',
      expiredIndicator: async (p) => {
        // Jobright redirects to login or shows a login modal
        const url = p.url();
        if (url.includes('/login') || url.includes('/signin')) return true;
        // Check for login modal
        const loginModal = await p.$('[data-testid="login-modal"], .login-modal, [class*="loginModal"]');
        return !!loginModal;
      },
    },
  };

  const check = checks[platform];
  if (!check) throw new Error(`Unknown platform: ${platform}`);

  try {
    // Navigate to the authenticated page with a 15-second timeout
    await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000); // Let any redirects settle

    const isExpired = await check.expiredIndicator(page);
    return !isExpired; // Returns true if logged in
  } catch (err) {
    // If navigation fails, assume session is expired
    return false;
  }
}

module.exports = {
  launchForPlatform,
  checkLoginStatus,
};
