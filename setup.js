#!/usr/bin/env node
'use strict';

/**
 * setup.js — One-time session capture for each platform.
 *
 * Usage: node setup.js --platform <linkedin|indeed|dice|jobright>
 *
 * This script launches a VISIBLE (headed) browser with the persistent profile
 * directory for the selected platform. You log in manually, then close the
 * browser. The session cookies are automatically saved to browser-data/<platform>/
 * and will be reused by the main automation on subsequent runs.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PLATFORM_URLS = {
  linkedin: 'https://www.linkedin.com/login',
  indeed: 'https://secure.indeed.com/auth?hl=en_US&co=US',
  dice: 'https://www.dice.com/dashboard',
  jobright: 'https://jobright.ai/login',
};

const PLATFORM_INSTRUCTIONS = {
  linkedin: [
    '1. Log in with your LinkedIn credentials.',
    '2. Complete any 2FA/CAPTCHA verification.',
    '3. Make sure your profile is 100% complete.',
    '4. Verify "Easy Apply" works by applying to one test job manually.',
    '5. When done, CLOSE this browser window.',
  ],
  indeed: [
    '1. Log in with your Indeed credentials.',
    '2. Complete any verification steps.',
    '3. Navigate to your profile and verify contact info + resume are uploaded.',
    '4. Test an "Easily apply" job to verify pre-fill works.',
    '5. When done, CLOSE this browser window.',
  ],
  dice: [
    '1. Log in with your Dice credentials.',
    '2. Complete your Dice profile (contact info, resume, work auth).',
    '3. Test an "Easy Apply" job to verify the modal works.',
    '4. When done, CLOSE this browser window.',
  ],
  jobright: [
    '1. Log in with your Jobright credentials.',
    '2. Upload your resume if not already uploaded.',
    '3. Complete your profile preferences.',
    '4. Test a "Quick Apply" job to verify the flow.',
    '5. When done, CLOSE this browser window.',
  ],
};

async function main() {
  const args = process.argv.slice(2);
  const platformIdx = args.indexOf('--platform');

  if (platformIdx === -1 || !args[platformIdx + 1]) {
    console.error('Usage: node setup.js --platform <linkedin|indeed|dice|jobright>');
    console.error('       node setup.js --platform all  (run setup for all platforms sequentially)');
    process.exit(1);
  }

  const platformArg = args[platformIdx + 1].toLowerCase();
  const platforms = platformArg === 'all' ? Object.keys(PLATFORM_URLS) : [platformArg];

  for (const platform of platforms) {
    if (!PLATFORM_URLS[platform]) {
      console.error(`Unknown platform: ${platform}`);
      console.error(`Valid platforms: ${Object.keys(PLATFORM_URLS).join(', ')}`);
      process.exit(1);
    }

    await setupPlatform(platform);

    if (platforms.length > 1 && platform !== platforms[platforms.length - 1]) {
      console.log('\nPress Enter to continue to the next platform...');
      await new Promise((resolve) => {
        process.stdin.once('data', resolve);
      });
    }
  }

  console.log('\n✓ Setup complete. You can now run the agent with: node index.js');
  process.exit(0);
}

async function setupPlatform(platform) {
  const profileDir = path.join(process.cwd(), 'browser-data', platform);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Setting up: ${platform.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}`);
  console.log('\nInstructions:');
  PLATFORM_INSTRUCTIONS[platform].forEach((line) => console.log(`  ${line}`));
  console.log('\nLaunching browser...\n');

  // Launch headed (visible) browser so user can interact
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, // MUST be headed for manual login
    viewport: { width: 1280, height: 800 },
    userAgent: CHROME_USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/Denver',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  context.on('close', () => {
    console.log(`\n✓ Browser closed. Session saved to: browser-data/${platform}/`);
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // Navigate to the platform's login page
  await page.goto(PLATFORM_URLS[platform], { waitUntil: 'domcontentloaded' });

  console.log('Browser is open. Complete the login process, then CLOSE the browser window.');
  console.log('Waiting for browser to close...');

  // Wait indefinitely until the browser context is closed by the user
  await new Promise((resolve) => context.on('close', resolve));

  console.log(`\nSession for ${platform} saved successfully.`);
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
