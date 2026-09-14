'use strict';

const assert = require('assert');
const { chromium } = require('playwright');

// These adapter tests use in-memory page doubles only. Keep the production
// control flow, but remove human pacing and form-filler side effects.
const humanize = require('../lib/humanize');
humanize.sleep = async () => {};
const formFiller = require('../lib/form-filler');
formFiller.fillForm = async () => ({ filledCount: 0, unfilledFields: [] });

const {
  applyIndeed,
  waitForSubmissionConfirmation: waitForIndeedConfirmation,
} = require('../modules/indeed');
const {
  applyDice,
  waitForSubmissionConfirmation: waitForDiceConfirmation,
} = require('../modules/dice');
const {
  applyJobright,
  waitForSubmissionConfirmation: waitForJobrightConfirmation,
} = require('../modules/jobright');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function configFor(platform) {
  return {
    platforms: { [platform]: { maxApplicationsPerRun: 1 } },
    search: { keywords: ['test'], location: 'United States' },
    behavior: {
      minDelayBetweenApplications: 0,
      maxDelayBetweenApplications: 0,
      maxRetries: 0,
      screenshotOnError: false,
    },
  };
}

function stateDouble({ hasApplied = false } = {}) {
  const records = [];
  return {
    records,
    hasApplied: () => hasApplied,
    recordApplication: (record) => records.push(record),
  };
}

test('real Playwright confirmation locators accept fresh evidence and reject stale or missing evidence', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    for (const fixture of [
      [waitForIndeedConfirmation, '<div data-testid="postApplyPage">Done</div>'],
      [waitForDiceConfirmation, '<div>Successfully applied</div>'],
      [waitForJobrightConfirmation, '<div data-testid="application-success">Done</div>'],
    ]) {
      const [waitForConfirmation, html] = fixture;
      await page.setContent(html);
      assert.strictEqual(await waitForConfirmation(page, { timeout: 100 }), true);
      assert.strictEqual(await waitForConfirmation(page, {
        timeout: 100,
        preexistingEvidence: true,
      }), false);
      await page.setContent('<div>No confirmation</div>');
      assert.strictEqual(await waitForConfirmation(page, { timeout: 50 }), false);
    }

    await page.setContent(
      '<div style="display:none">Application submitted</div><div>Application submitted</div>'
    );
    for (const waitForConfirmation of [
      waitForIndeedConfirmation,
      waitForDiceConfirmation,
      waitForJobrightConfirmation,
    ]) {
      assert.strictEqual(await waitForConfirmation(page, { timeout: 100 }), true);
    }

    await page.setContent('<iframe srcdoc="<div>Your application has been submitted</div>"></iframe>');
    const applyFrame = page.frames().find((frame) => frame !== page.mainFrame());
    assert(applyFrame);
    assert.strictEqual(
      await waitForIndeedConfirmation([page, applyFrame], { timeout: 100 }),
      true
    );
  } finally {
    await browser.close();
  }
});

test('Indeed propagates an initial CAPTCHA block', async () => {
  const state = stateDouble();
  const stats = await applyIndeed({
    goto: async () => {},
    content: async () => '<div>unusual activity</div>',
  }, configFor('indeed'), {}, state, 'run-indeed-blocked', logger);

  assert.strictEqual(stats.aborted, false);
  assert.strictEqual(stats.captchaBlocked, true);
  assert.strictEqual(state.records[0].status, 'captcha_blocked');
});

test('Dice propagates an initial block page', async () => {
  const state = stateDouble();
  const stats = await applyDice({
    goto: async () => {},
    content: async () => '<div>Checking your browser</div>',
  }, configFor('dice'), {}, state, 'run-dice-blocked', logger);

  assert.strictEqual(stats.aborted, false);
  assert.strictEqual(stats.captchaBlocked, true);
  assert.strictEqual(state.records[0].status, 'captcha_blocked');
});

test('Jobright propagates an initial challenge page', async () => {
  const state = stateDouble();
  const stats = await applyJobright({
    goto: async () => {},
    url: () => 'https://jobright.ai/jobs',
    $: async () => null,
    content: async () => '<div>Just a moment</div>',
  }, configFor('jobright'), {}, state, 'run-jobright-blocked', logger);

  assert.strictEqual(stats.aborted, false);
  assert.strictEqual(stats.captchaBlocked, true);
  assert.strictEqual(state.records[0].status, 'captcha_blocked');
});

test('empty first-page scans are reported as noResults', async () => {
  const indeedState = stateDouble();
  const indeedStats = await applyIndeed({
    goto: async () => {},
    content: async () => '',
    $: async () => null,
    waitForSelector: async () => { throw new Error('missing results'); },
  }, configFor('indeed'), {}, indeedState, 'run-indeed-empty', logger);

  const diceState = stateDouble();
  const diceStats = await applyDice({
    goto: async () => {},
    content: async () => '',
    waitForSelector: async () => { throw new Error('missing results'); },
  }, configFor('dice'), {}, diceState, 'run-dice-empty', logger);

  const jobrightState = stateDouble();
  const jobrightStats = await applyJobright({
    goto: async () => {},
    url: () => 'https://jobright.ai/jobs',
    $: async () => null,
    content: async () => '',
    waitForSelector: async () => { throw new Error('missing feed'); },
  }, configFor('jobright'), {}, jobrightState, 'run-jobright-empty', logger);

  assert.strictEqual(indeedStats.noResults, true);
  assert.strictEqual(diceStats.noResults, true);
  assert.strictEqual(jobrightStats.noResults, true);
});

test('Indeed records an unconfirmed submit distinctly, never submitted', async () => {
  const state = stateDouble();
  let submitClicks = 0;
  const submitButton = { isVisible: async () => true, click: async () => { submitClicks++; } };
  const applyButton = { isVisible: async () => true, click: async () => {} };
  const makeCard = (id) => ({
    getAttribute: async (name) => name === 'data-jk' ? id : null,
    $: async (selector) => selector.includes('easily-apply-badge') ? {} : null,
    click: async () => {},
  });
  let currentUrl = 'https://www.indeed.com/jobs';
  const page = {
    goto: async (url) => { currentUrl = url; },
    url: () => currentUrl,
    content: async () => '',
    $$: async () => [makeCard('indeed-job-1'), makeCard('indeed-job-2')],
    $: async (selector) => {
      if (selector.includes('indeedApplyButton')) return applyButton;
      if (selector.includes('Submit your application')) return submitButton;
      return null;
    },
    waitForSelector: async (selector) => {
      if (selector.includes('Your application has been submitted')) return null;
      return {};
    },
  };

  const stats = await applyIndeed(
    page, configFor('indeed'), {}, state, 'run-indeed-unconfirmed', logger
  );

  assert.strictEqual(stats.applied, 0);
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(stats.submissionAttempts, 1);
  assert.strictEqual(submitClicks, 1);
  assert.strictEqual(state.records.some((row) => row.status === 'submitted'), false);
  assert.strictEqual(state.records.some((row) => row.status === 'submit_unconfirmed'), true);
});

test('Dice records an unconfirmed submit distinctly, never submitted', async () => {
  const state = stateDouble();
  const makeCard = (id) => ({
    $: async (selector) => selector.includes('/job-detail/')
      ? { getAttribute: async () => `/job-detail/${id}` }
      : null,
  });
  const easyApplyButton = {
    isVisible: async () => true,
    innerText: async () => 'Easy Apply',
    click: async () => {},
  };
  let submitClicks = 0;
  const submitButton = { isVisible: async () => true, click: async () => { submitClicks++; } };
  let currentUrl = 'https://www.dice.com/jobs';
  const page = {
    goto: async (url) => { currentUrl = url; },
    url: () => currentUrl,
    content: async () => '',
    $$: async () => [makeCard('dice-job-1'), makeCard('dice-job-2')],
    $: async (selector) => {
      if (selector.includes('Easy Apply')) return easyApplyButton;
      if (selector.includes('submit-apply')) return submitButton;
      return null;
    },
    waitForSelector: async (selector) => {
      if (selector.includes('Application Submitted')) return null;
      return {};
    },
  };

  const stats = await applyDice(page, configFor('dice'), {}, state, 'run-dice-unconfirmed', logger);

  assert.strictEqual(stats.applied, 0);
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(stats.submissionAttempts, 1);
  assert.strictEqual(submitClicks, 1);
  assert.strictEqual(state.records.some((row) => row.status === 'submitted'), false);
  assert.strictEqual(state.records.some((row) => row.status === 'submit_unconfirmed'), true);
});

test('Jobright records an unconfirmed submit distinctly, never submitted', async () => {
  const state = stateDouble();
  const makeCard = (id) => ({
    getAttribute: async (name) => name === 'data-job-id' ? id : null,
    $: async () => null,
    click: async () => {},
  });
  const applyButton = {
    isVisible: async () => true,
    innerText: async () => 'Quick Apply',
    click: async () => {},
  };
  let submitClicks = 0;
  const submitButton = { isVisible: async () => true, click: async () => { submitClicks++; } };
  let currentUrl = 'https://jobright.ai/jobs';
  const page = {
    goto: async (url) => { currentUrl = url; },
    goBack: async () => { currentUrl = 'https://jobright.ai/jobs'; },
    url: () => currentUrl,
    content: async () => '',
    evaluate: async () => {},
    $$: async () => [makeCard('jobright-job-1'), makeCard('jobright-job-2')],
    $: async (selector) => {
      if (selector.includes('login-modal')) return null;
      if (selector.includes('apply-button')) return applyButton;
      if (selector.includes('submit-button')) return submitButton;
      return null;
    },
    waitForSelector: async (selector) => {
      if (selector.includes('Application submitted')) return null;
      return {};
    },
  };

  const stats = await applyJobright(
    page, configFor('jobright'), {}, state, 'run-jobright-unconfirmed', logger
  );

  assert.strictEqual(stats.applied, 0);
  assert.strictEqual(stats.errors, 1);
  assert.strictEqual(stats.submissionAttempts, 1);
  assert.strictEqual(submitClicks, 1);
  assert.strictEqual(state.records.some((row) => row.status === 'submitted'), false);
  assert.strictEqual(state.records.some((row) => row.status === 'submit_unconfirmed'), true);
});

test('Jobright auto-submit confirmation inside a dialog still consumes one attempt', async () => {
  const state = stateDouble();
  let confirmationVisible = false;
  let applyClicks = 0;
  const visibleMatch = { isVisible: async () => true };
  const confirmationLocator = {
    all: async () => confirmationVisible ? [visibleMatch] : [],
  };
  const card = {
    getAttribute: async (name) => name === 'data-job-id' ? 'jobright-auto-submit' : null,
    $: async () => null,
    click: async () => {},
  };
  const applyButton = {
    isVisible: async () => true,
    innerText: async () => 'Quick Apply',
    click: async () => {
      applyClicks++;
      confirmationVisible = true;
    },
  };
  const page = {
    goto: async () => {},
    goBack: async () => {},
    url: () => 'https://jobright.ai/jobs',
    content: async () => '',
    evaluate: async () => {},
    locator: () => confirmationLocator,
    getByText: () => confirmationLocator,
    $$: async () => [card],
    $: async (selector) => {
      if (selector.includes('login-modal')) return null;
      if (selector.includes('apply-button')) return applyButton;
      return null;
    },
    waitForSelector: async () => ({}), // includes the broad role=dialog form shell
  };

  const stats = await applyJobright(
    page, configFor('jobright'), {}, state, 'run-jobright-auto', logger
  );
  assert.strictEqual(applyClicks, 1);
  assert.strictEqual(stats.applied, 1);
  assert.strictEqual(stats.submissionAttempts, 1);
  assert.strictEqual(state.records.filter((row) => row.status === 'submitted').length, 1);
});

test('Jobright dry-run stops before the potentially auto-submitting Apply click', async () => {
  const state = stateDouble();
  let applyClicks = 0;
  const card = {
    getAttribute: async (name) => name === 'data-job-id' ? 'jobright-dry-run' : null,
    $: async () => null,
    click: async () => {},
  };
  const applyButton = {
    isVisible: async () => true,
    innerText: async () => 'Quick Apply',
    click: async () => { applyClicks++; },
  };
  const page = {
    goto: async () => {},
    goBack: async () => {},
    url: () => 'https://jobright.ai/jobs',
    content: async () => '',
    evaluate: async () => {},
    $$: async () => [card],
    $: async (selector) => {
      if (selector.includes('login-modal')) return null;
      if (selector.includes('apply-button')) return applyButton;
      return null;
    },
    waitForSelector: async () => ({}),
  };

  const stats = await applyJobright(
    page, configFor('jobright'), {}, state, 'run-jobright-dry', logger, true
  );
  assert.strictEqual(applyClicks, 0);
  assert.strictEqual(stats.applied, 0);
  assert.strictEqual(stats.dryRunReady, 1);
  assert.strictEqual(state.records[0].status, 'dry_run');
});

test('database dedup rows are labeled separately from platform evidence', async () => {
  const indeedState = stateDouble({ hasApplied: true });
  const indeedCard = {
    getAttribute: async () => 'indeed-dedup',
  };
  await applyIndeed({
    goto: async () => {},
    content: async () => '',
    $: async () => null,
    $$: async () => [indeedCard],
    waitForSelector: async () => ({}),
  }, configFor('indeed'), {}, indeedState, 'run-indeed-dedup', logger);

  const diceState = stateDouble({ hasApplied: true });
  const diceLink = { getAttribute: async () => '/job-detail/dice-dedup' };
  const diceCard = { $: async () => diceLink };
  await applyDice({
    goto: async () => {},
    content: async () => '',
    $: async () => null,
    $$: async () => [diceCard],
    waitForSelector: async () => ({}),
  }, configFor('dice'), {}, diceState, 'run-dice-dedup', logger);

  const jobrightState = stateDouble({ hasApplied: true });
  const jobrightCard = {
    getAttribute: async () => 'jobright-dedup',
  };
  await applyJobright({
    goto: async () => {},
    goBack: async () => {},
    url: () => 'https://jobright.ai/jobs',
    content: async () => '',
    evaluate: async () => {},
    $: async () => null,
    $$: async () => [jobrightCard],
    waitForSelector: async () => ({}),
  }, configFor('jobright'), {}, jobrightState, 'run-jobright-dedup', logger);

  assert.strictEqual(indeedState.records[0].skipReason, 'already_applied_db');
  assert.strictEqual(diceState.records[0].skipReason, 'already_applied_db');
  assert.strictEqual(jobrightState.records[0].skipReason, 'already_applied_db');
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log('\n=== Platform Fail-Closed Tests ===\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}: ${err.stack || err.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
