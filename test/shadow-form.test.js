'use strict';

// Fixture test for fillShadowForm (spec R8/R9/R10/R11/R14).
// Builds a synthetic #interop-outlet shadow form shaped like LinkedIn's:
// radios live in their own option <div>s inside a <fieldset> with a <legend>.
// Asserts: fieldset-first group labels, never-auto-answer guard, output
// validation, no Yes-default, and Top Choice policy (never check by default).

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-shadow-test-'));
process.env.STATE_DB_PATH = path.join(tmpDir, 'test.db');

const { chromium } = require('playwright');
const { fillShadowForm } = require('../modules/linkedin');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

const config = {
  user: {
    firstName: 'Sam',
    city: 'Springfield',
    workAuthorization: 'US Citizen',
    requiresSponsorship: false,
    veteranStatus: 'I am not a protected veteran',
  },
};

const defaultAnswers = {
  'are you willing to relocate': 'Yes',
  'website': '[PORTFOLIO_URL]',
  'city': 'Springfield',
};

function radioGroup(idPrefix, legend) {
  // Each option in its own <div> — the structure that broke closest('fieldset, div, li')
  return `
    <fieldset>
      <legend>${legend}</legend>
      <div class="option">
        <input type="radio" id="${idPrefix}-yes" name="${idPrefix}" value="Yes">
        <label for="${idPrefix}-yes">Yes</label>
      </div>
      <div class="option">
        <input type="radio" id="${idPrefix}-no" name="${idPrefix}" value="No">
        <label for="${idPrefix}-no">No</label>
      </div>
    </fieldset>`;
}

const SHADOW_HTML = `
  ${radioGroup('military', 'Have you ever served in the military? Select one of the following:')}
  ${radioGroup('workauth', 'Are you authorized to work in the United States?')}
  ${radioGroup('relocate', 'Are you willing to relocate?')}
  <div>
    <label for="website">Website</label>
    <input type="text" id="website">
  </div>
  <div>
    <label for="city">City</label>
    <input type="text" id="city">
  </div>
  <div>
    <label for="school">School</label>
    <select id="school">
      <option value="">Select an option</option>
      <option value="abac">Abraham Baldwin Agricultural College</option>
      <option value="mit">Massachusetts Institute of Technology</option>
    </select>
  </div>
  <div>
    <input type="checkbox" id="topchoice">
    <label for="topchoice">Mark job as a top choice.</label>
  </div>
  <div>
    <input type="checkbox" id="agree">
    <label for="agree">I agree to the Terms &amp; Conditions</label>
  </div>
`;

(async () => {
  let passed = 0;
  let failed = 0;
  function check(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}: ${err.message}`);
    }
  }

  console.log('\n=== Shadow Form Fixture Tests ===\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<div id="interop-outlet"></div>');
  await page.evaluate((html) => {
    const host = document.querySelector('#interop-outlet');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = html;
  }, SHADOW_HTML);

  const result = await fillShadowForm(page, defaultAnswers, noopLogger, 'fixture-job', {
    config,
    runId: 'fixture-run',
  });

  const domState = await page.evaluate(() => {
    const sr = document.querySelector('#interop-outlet').shadowRoot;
    const byId = (id) => sr.querySelector('#' + id);
    return {
      militaryYes: byId('military-yes').checked,
      militaryNo: byId('military-no').checked,
      workauthYes: byId('workauth-yes').checked,
      relocateYes: byId('relocate-yes').checked,
      website: byId('website').value,
      city: byId('city').value,
      school: byId('school').value,
      topchoice: byId('topchoice').checked,
      agree: byId('agree').checked,
    };
  });

  // ── Never-auto-answer guard ──
  check('military radio group is left unanswered (guarded, no config fact)', () => {
    assert.strictEqual(domState.militaryYes, false);
    assert.strictEqual(domState.militaryNo, false);
  });

  check('guarded work-authorization radio answers Yes from config', () => {
    assert.strictEqual(domState.workauthYes, true);
  });

  check('school dropdown never picks the alphabetically first option', () => {
    assert.strictEqual(domState.school, '');
  });

  // ── Radio group labels come from the fieldset legend, not option wrappers ──
  check('blocked military question is reported with the legend text, not "Yes"', () => {
    const labels = [
      ...result.unfilled.map((f) => f.label),
      ...(result.blocked || []).map((f) => f.label),
    ];
    assert(labels.some((l) => l.includes('served in the military')),
      `expected a label containing the legend, got: ${JSON.stringify(labels)}`);
    assert(!labels.some((l) => l.trim() === 'Yes'), 'option text leaked as a group label');
  });

  // ── Unguarded fills still work ──
  check('relocation radio fills Yes via exact defaultAnswers match', () => {
    assert.strictEqual(domState.relocateYes, true);
  });

  check('city text input fills from defaultAnswers', () => {
    assert.strictEqual(domState.city, 'Springfield');
  });

  // ── Output validation ──
  check('placeholder answer is rejected, website stays empty', () => {
    assert.strictEqual(domState.website, '');
  });

  // ── No blind Yes-default for unmatched radios ──
  check('no radio group was answered by a Yes-default fallback', () => {
    // military is the only unmatched group; already asserted unchecked above.
    // Belt-and-braces: no fill record may cite a yes-default source.
    const sources = (result.fills || []).map((f) => f.source + ':' + f.matchType);
    assert(!sources.some((s) => /yes_or_first|first_option/.test(s)), sources.join(', '));
  });

  // ── Top Choice policy (spec R14): default never ──
  check('top-choice checkbox stays unchecked under default policy', () => {
    assert.strictEqual(domState.topchoice, false);
  });

  check('top-choice encounter is reported for auditing', () => {
    assert(result.topChoice && result.topChoice.present === true);
    assert.strictEqual(result.topChoice.checked, false);
  });

  // ── Consent checkboxes still work ──
  check('agree/consent checkbox is checked', () => {
    assert.strictEqual(domState.agree, true);
  });

  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FIXTURE HARNESS FAILED:', err);
  process.exit(1);
});
