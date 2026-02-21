'use strict';

const crypto = require('crypto');

/**
 * Generate a random integer between min (inclusive) and max (inclusive)
 * using crypto for better randomness than Math.random().
 */
function randomInt(min, max) {
  const range = max - min + 1;
  const bytesNeeded = Math.ceil(Math.log2(range) / 8);
  const maxValid = Math.floor(256 ** bytesNeeded / range) * range;
  let value;
  do {
    const buf = crypto.randomBytes(bytesNeeded);
    value = 0;
    for (const byte of buf) value = value * 256 + byte;
  } while (value >= maxValid);
  return min + (value % range);
}

/**
 * Approximate a normal distribution between min and max by averaging
 * multiple uniform samples (central limit theorem approximation).
 */
function normalDelay(min, max, samples = 3) {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    sum += randomInt(min, max);
  }
  return Math.round(sum / samples);
}

/**
 * Sleep for a random duration between min and max milliseconds.
 * Uses a normal distribution so most delays cluster in the middle.
 * @param {number} min - minimum milliseconds
 * @param {number} max - maximum milliseconds
 * @returns {Promise<void>}
 */
function sleep(min, max) {
  const delay = max !== undefined ? normalDelay(min, max) : min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Type text into a page element with human-like per-character delays.
 * Playwright's page.fill() is instant — this is more realistic.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector - CSS selector for the input field
 * @param {string} text - text to type
 * @param {object} [options]
 * @param {number} [options.min=50] - min ms between keystrokes
 * @param {number} [options.max=150] - max ms between keystrokes
 */
async function typeWithDelay(page, selector, text, options = {}) {
  const { min = 50, max = 150 } = options;

  // Click to focus the element first
  await page.click(selector);
  await sleep(100, 300);

  // Clear any existing value
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, selector);

  // Type each character with a delay
  for (const char of text) {
    await page.type(selector, char, { delay: 0 });
    await sleep(min, max);

    // Occasionally pause mid-word (5% chance) to simulate thinking
    if (randomInt(1, 20) === 1) {
      await sleep(300, 800);
    }
  }
}

/**
 * Scroll down a page in human-like chunks with pauses between scrolls.
 * Simulates reading/scanning behavior rather than instant scroll-to-bottom.
 *
 * @param {import('playwright').Page} page
 * @param {number} [totalPixels=3000] - total pixels to scroll
 */
async function scrollLikeHuman(page, totalPixels = 3000) {
  let scrolled = 0;
  while (scrolled < totalPixels) {
    // Scroll a random chunk: 100–400px at a time
    const chunk = randomInt(100, 400);
    await page.evaluate((px) => window.scrollBy(0, px), chunk);
    scrolled += chunk;
    await sleep(300, 900);
  }
}

/**
 * Move the mouse to a random position within an element before clicking.
 * Adds realism vs always clicking the exact center.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').ElementHandle} element
 */
async function humanClick(page, element) {
  const box = await element.boundingBox();
  if (!box) {
    await element.click();
    return;
  }

  // Random point within the element's bounding box (with 10% padding)
  const padX = box.width * 0.1;
  const padY = box.height * 0.1;
  const x = box.x + padX + randomInt(0, Math.floor(box.width - 2 * padX));
  const y = box.y + padY + randomInt(0, Math.floor(box.height - 2 * padY));

  await page.mouse.move(x, y, { steps: randomInt(5, 15) });
  await sleep(50, 150);
  await page.mouse.click(x, y);
}

module.exports = {
  sleep,
  randomInt,
  typeWithDelay,
  scrollLikeHuman,
  humanClick,
};
