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
const {
  fillShadowForm,
  fillDialogRadioGroups,
  handleInlineApplyStep,
  collectApplyValidationErrors,
  detectTopChoiceBlocked,
  waitForSubmissionConfirmation,
  firstVisibleApplyControl,
  markActiveApplyDialog,
  dismissActiveApplyUi,
} = require('../modules/linkedin');

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
  'are you able to commute': 'Yes',
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
    <input type="checkbox" id="topchoice" checked>
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
  check('preselected shadow Top Choice is actively cleared under default policy', () => {
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

  // ── 2026-08 dialog radio groups ──
  const dialogRadioGroup = (id, question) => `
    <p>${question}</p>
    <fieldset id="${id}" role="radiogroup">
      <div role="radio" aria-label="Yes" aria-checked="false"
           onclick="this.setAttribute('aria-checked', 'true')">Yes</div>
      <div role="radio" aria-label="No" aria-checked="false"
           onclick="this.setAttribute('aria-checked', 'true')">No</div>
    </fieldset>`;
  const dialogOptionGroup = (id, question, optionLabels) => `
    <p>${question}</p>
    <fieldset id="${id}" role="radiogroup">
      ${optionLabels.map((label) => `
        <div role="radio" aria-label="${label}" aria-checked="false"
             onclick="this.setAttribute('aria-checked', 'true')">${label}</div>`).join('')}
    </fieldset>`;

  await page.setContent(`
    <dialog open>
      <div>1/2 pages</div>
      ${dialogRadioGroup('dialog-relocate', 'Are you willing to relocate?')}
    </dialog>`);
  await fillDialogRadioGroups(page, defaultAnswers, config, noopLogger, 'dialog-job', {
    runId: 'fixture-run',
    guardBlockedLabels: new Set(),
  });
  await page.locator('dialog').evaluate((dialog, html) => {
    dialog.insertAdjacentHTML('beforeend', html);
  }, dialogRadioGroup('dialog-commute', 'Are you able to commute?'));
  await fillDialogRadioGroups(page, defaultAnswers, config, noopLogger, 'dialog-job', {
    runId: 'fixture-run',
    guardBlockedLabels: new Set(),
  });

  const dialogCommuteChecked = await page.locator('#dialog-commute [role="radio"][aria-label="Yes"]')
    .getAttribute('aria-checked');
  check('dialog radio markers do not collide across retained form steps', () => {
    assert.strictEqual(dialogCommuteChecked, 'true');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('dialog-military', 'Have you ever served in the military?')}
    </dialog>`);
  const guardBlockedLabels = new Set();
  await fillDialogRadioGroups(page, defaultAnswers, { user: {} }, noopLogger, 'dialog-guard-job', {
    runId: 'fixture-run',
    guardBlockedLabels,
  });

  const guardedDialogSelected = await page.locator('#dialog-military [role="radio"][aria-checked="true"]').count();
  check('guarded dialog radio is left unanswered', () => {
    assert.strictEqual(guardedDialogSelected, 0);
  });

  check('guarded dialog radio is propagated for honest-skip classification', () => {
    assert([...guardBlockedLabels].some((label) => label.includes('served in the military')),
      `expected guarded question label, got: ${JSON.stringify([...guardBlockedLabels])}`);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('dialog-license', "Do you have a valid driver's license?")}
      ${dialogRadioGroup('dialog-cro', 'Do you have experience working for a CRO?')}
      ${dialogRadioGroup('dialog-visa', 'Do you currently hold OPT, STEM OPT, EAD, or H-1B status?')}
    </dialog>`);
  const factualRadioLabels = new Set();
  const factualRadioBudget = { callsRemaining: 3, msRemaining: 10000 };
  const previousApiKey = process.env.API_KEY;
  delete process.env.API_KEY;
  await fillDialogRadioGroups(page, {}, { user: {} }, noopLogger, 'dialog-factual-job', {
    runId: 'fixture-run',
    guardBlockedLabels: factualRadioLabels,
    llmCache: new Map(),
    llmBudget: factualRadioBudget,
  });
  if (previousApiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = previousApiKey;
  const factualRadioSelected = await page.locator('[role="radiogroup"] [role="radio"][aria-checked="true"]').count();
  check('ungrounded licence, experience, and visa facts never use radio LLM fallback', () => {
    assert.strictEqual(factualRadioSelected, 0);
    assert.strictEqual(factualRadioBudget.callsRemaining, 3);
    assert.strictEqual(factualRadioLabels.size, 3);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('config-relocate', 'Are you willing to relocate?')}
    </dialog>`);
  await fillDialogRadioGroups(
    page, {}, { user: { willingToRelocate: false } }, noopLogger, 'dialog-config-job', {
      runId: 'fixture-run', guardBlockedLabels: new Set(),
    }
  );
  const configRelocateNo = await page.locator('#config-relocate [role="radio"][aria-label="No"]')
    .getAttribute('aria-checked');
  check('explicit relocation config grounds a dialog No answer', () => {
    assert.strictEqual(configRelocateNo, 'true');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('unknown-age', 'Are you over 18?')}
      ${dialogOptionGroup(
        'skill-years',
        'How many years of experience do you have with Kubernetes?',
        ['0', '3']
      )}
    </dialog>`);
  const ungroundedGenericLabels = new Set();
  await fillDialogRadioGroups(
    page, { 'years of experience': '3' }, { user: {} }, noopLogger, 'dialog-ungrounded-job', {
      runId: 'fixture-run', guardBlockedLabels: ungroundedGenericLabels,
    }
  );
  const ungroundedGenericSelected = await page.locator(
    '#unknown-age [role="radio"][aria-checked="true"], #skill-years [role="radio"][aria-checked="true"]'
  ).count();
  check('generic rules and fuzzy defaults do not invent dialog radio facts', () => {
    assert.strictEqual(ungroundedGenericSelected, 0);
    assert.strictEqual(ungroundedGenericLabels.size, 2);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('negated-relocate', 'Are you not willing to relocate?')}
      ${dialogRadioGroup('negated-license', "Do you not have a driver's license?")}
      ${dialogRadioGroup('negated-auth', 'Are you unauthorized to work in the United States?')}
      ${dialogRadioGroup('negated-sponsor', 'Will you not require sponsorship?')}
      ${dialogRadioGroup('compound-auth', 'Are you authorized to work without sponsorship?')}
      ${dialogRadioGroup('qualified-license', "Do you have a valid commercial driver's license?")}
      ${dialogRadioGroup('compound-age', 'Are you over 18 and able to work weekends?')}
      ${dialogRadioGroup('named-commute', 'Are you able to commute to Denver?')}
      ${dialogRadioGroup('compound-auth-age', 'Are you at least 18 and legally authorized to work in the US?')}
    </dialog>`);
  const unsafeBooleanLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, {
      user: {
        willingToRelocate: true,
        hasDriversLicense: true,
        workAuthorization: 'US Citizen',
        requiresSponsorship: false,
        over18: true,
        willingToCommute: true,
      },
    }, noopLogger, 'dialog-polarity-job', {
      runId: 'fixture-run', guardBlockedLabels: unsafeBooleanLabels,
    }
  );
  const unsafeBooleanSelected = await page.locator(
    '[role="radiogroup"] [role="radio"][aria-checked="true"]'
  ).count();
  check('negated, compound, and qualified booleans require exact dialog answers', () => {
    assert.strictEqual(unsafeBooleanSelected, 0);
    assert.strictEqual(unsafeBooleanLabels.size, 9);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogOptionGroup(
        'cc305-disability',
        'Voluntary Self-Identification of Disability. You are not required to disclose this information.',
        ['Yes, I have a disability', 'No, I do not have a disability', 'I do not want to answer']
      )}
    </dialog>`);
  const cc305Labels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { disabilityStatus: 'I do not wish to answer' } },
    noopLogger, 'dialog-cc305-job', {
      runId: 'fixture-run', guardBlockedLabels: cc305Labels,
    }
  );
  const cc305Decline = await page.locator(
    '#cc305-disability [role="radio"][aria-label="I do not want to answer"]'
  ).getAttribute('aria-checked');
  check('EEO disclosure preamble still uses configured decline-to-answer status', () => {
    assert.strictEqual(cc305Decline, 'true');
    assert.deepStrictEqual([...cc305Labels], []);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogOptionGroup('negated-gender-category', 'Which gender do you not identify as?', ['Male', 'Female'])}
    </dialog>`);
  const negatedCategoryLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { gender: 'Male' } }, noopLogger, 'dialog-negated-category-job', {
      runId: 'fixture-run', guardBlockedLabels: negatedCategoryLabels,
    }
  );
  const negatedCategorySelected = await page.locator(
    '#negated-gender-category [role="radio"][aria-checked="true"]'
  ).count();
  check('guarded categorical config cannot bypass a logically negated question', () => {
    assert.strictEqual(negatedCategorySelected, 0);
    assert.strictEqual(negatedCategoryLabels.size, 1);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup(
        'sponsorship-alternatives',
        'Will you now or in the future require employer sponsorship for a work visa or employment authorization?'
      )}
    </dialog>`);
  const sponsorshipAlternativeLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { requiresSponsorship: false } },
    noopLogger, 'dialog-sponsorship-alternatives-job', {
      runId: 'fixture-run', guardBlockedLabels: sponsorshipAlternativeLabels,
    }
  );
  const sponsorshipAlternativeNo = await page.locator(
    '#sponsorship-alternatives [role="radio"][aria-label="No"]'
  ).getAttribute('aria-checked');
  check('recognized sponsorship alternatives remain one configured predicate', () => {
    assert.strictEqual(sponsorshipAlternativeNo, 'true');
    assert.deepStrictEqual([...sponsorshipAlternativeLabels], []);
  });

  const raceDefinitionBlob = `
    Hispanic or Latino: A person of Cuban, Mexican, Puerto Rican, South or Central American,
    or other Spanish culture or origin regardless of ancestry. Asian: A person having origins in
    any of the original peoples of the Far East, Southeast Asia, or the Indian subcontinent.
    Black or African American: A person having origins in any of the Black racial groups of
    Africa. White (Not Hispanic or Latino): A person having origins in any of the original
    peoples of Europe, the Middle East, or North Africa. American Indian or Alaska Native:
    A person having origins in any of the original peoples of North and South America.
    Native Hawaiian or Other Pacific Islander: A person having origins in Hawaii, Guam,
    Samoa, or other Pacific Islands. You are not required to provide this information.`;
  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogOptionGroup(
        'race-definition-options', raceDefinitionBlob,
        ['Asian', 'Black or African American', 'White', 'I prefer not to specify']
      )}
    </dialog>`);
  const raceDefinitionLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { race: 'Prefer not to say' } },
    noopLogger, 'dialog-race-definition-job', {
      runId: 'fixture-run', guardBlockedLabels: raceDefinitionLabels,
    }
  );
  const raceDefinitionOptOut = await page.locator(
    '#race-definition-options [role="radio"][aria-label="I prefer not to specify"]'
  ).getAttribute('aria-checked');
  check('EEO race definition option-set uses only configured race opt-out', () => {
    assert.strictEqual(raceDefinitionOptOut, 'true');
    assert.deepStrictEqual([...raceDefinitionLabels], []);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogOptionGroup(
        'negated-race-options', 'Which of these races do you not identify as?',
        ['Hispanic or Latino', 'Asian', 'Black or African American', 'White']
      )}
    </dialog>`);
  const negatedRaceLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { race: 'Asian' } }, noopLogger, 'dialog-negated-race-job', {
      runId: 'fixture-run', guardBlockedLabels: negatedRaceLabels,
    }
  );
  const negatedRaceSelected = await page.locator(
    '#negated-race-options [role="radio"][aria-checked="true"]'
  ).count();
  check('race option-set cannot bypass a logically negated category question', () => {
    assert.strictEqual(negatedRaceSelected, 0);
    assert.strictEqual(negatedRaceLabels.size, 1);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogOptionGroup(
        'negated-race-definition-options',
        `Which race do you NOT identify as? ${raceDefinitionBlob}`,
        ['Hispanic or Latino', 'Asian', 'Black or African American', 'White']
      )}
    </dialog>`);
  const negatedRaceDefinitionLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { race: 'Asian' } }, noopLogger, 'dialog-negated-race-definition-job', {
      runId: 'fixture-run', guardBlockedLabels: negatedRaceDefinitionLabels,
    }
  );
  const negatedRaceDefinitionSelected = await page.locator(
    '#negated-race-definition-options [role="radio"][aria-checked="true"]'
  ).count();
  check('race definition prose cannot override an inverse category prompt', () => {
    assert.strictEqual(negatedRaceDefinitionSelected, 0);
    assert.strictEqual(negatedRaceDefinitionLabels.size, 1);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogOptionGroup(
        'imperative-negated-race-definition-options',
        `Please select the race you do NOT identify as. ${raceDefinitionBlob}`,
        ['Hispanic or Latino', 'Asian', 'Black or African American', 'White']
      )}
    </dialog>`);
  const imperativeNegatedRaceLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { race: 'Asian' } }, noopLogger, 'dialog-imperative-negated-race-job', {
      runId: 'fixture-run', guardBlockedLabels: imperativeNegatedRaceLabels,
    }
  );
  const imperativeNegatedRaceSelected = await page.locator(
    '#imperative-negated-race-definition-options [role="radio"][aria-checked="true"]'
  ).count();
  check('race definitions cannot override an imperative inverse prompt', () => {
    assert.strictEqual(imperativeNegatedRaceSelected, 0);
    assert.strictEqual(imperativeNegatedRaceLabels.size, 1);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogOptionGroup(
        'gender-with-opt-out', 'Gender',
        ['Male', 'Female', 'Prefer not to answer']
      )}
    </dialog>`);
  const crossSensitiveLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { gender: 'Male', race: 'Prefer not to answer' } },
    noopLogger, 'dialog-cross-sensitive-job', {
      runId: 'fixture-run', guardBlockedLabels: crossSensitiveLabels,
    }
  );
  const crossSensitiveMale = await page.locator(
    '#gender-with-opt-out [role="radio"][aria-label="Male"]'
  ).getAttribute('aria-checked');
  const crossSensitiveOptOut = await page.locator(
    '#gender-with-opt-out [role="radio"][aria-label="Prefer not to answer"]'
  ).getAttribute('aria-checked');
  check('race opt-out config never overrides another sensitive category', () => {
    assert.strictEqual(crossSensitiveMale, 'true');
    assert.strictEqual(crossSensitiveOptOut, 'false');
    assert.deepStrictEqual([...crossSensitiveLabels], []);
  });

  await page.setContent(`
    <dialog>
      <div>1/1 pages</div>
      <div role="alert">Please enter a valid answer</div>
      <input id="hidden-top-choice" type="checkbox">
      <label for="hidden-top-choice">Mark this job as a Top Choice</label>
      ${dialogRadioGroup('hidden-military', 'Have you ever served in the military?')}
    </dialog>
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('active-relocate', 'Are you willing to relocate?')}
    </dialog>`);
  const activeGuardBlockedLabels = new Set();
  const activeDialogResult = await fillDialogRadioGroups(
    page, defaultAnswers, { user: {} }, noopLogger, 'dialog-active-job', {
      runId: 'fixture-run',
      guardBlockedLabels: activeGuardBlockedLabels,
    }
  );
  const activeRelocateChecked = await page
    .locator('#active-relocate [role="radio"][aria-label="Yes"]')
    .getAttribute('aria-checked');
  const hiddenMilitaryChecked = await page.locator('#hidden-military [role="radio"][aria-checked="true"]').count();
  const activeValidationErrors = await collectApplyValidationErrors(page);
  const hiddenTopChoiceBlocked = await detectTopChoiceBlocked(page);

  check('dialog filler ignores retained closed templates', () => {
    assert.strictEqual(activeDialogResult.groups, 1);
    assert.strictEqual(activeRelocateChecked, 'true');
    assert.strictEqual(hiddenMilitaryChecked, 0);
    assert.deepStrictEqual([...activeGuardBlockedLabels], []);
  });

  check('validation ignores stale errors in retained closed dialogs', () => {
    assert.deepStrictEqual(activeValidationErrors, []);
  });

  check('Top Choice detection ignores retained closed dialogs', () => {
    assert.strictEqual(hiddenTopChoiceBlocked, false);
  });

  await page.setContent(`
    <dialog open>
      <div style="display:none">
        <input id="reused-top-choice" type="checkbox">
        <label for="reused-top-choice">Optional preference</label>
      </div>
      <div>
        <input id="reused-top-choice" type="checkbox" required>
        <label for="reused-top-choice">Mark this job as a Top Choice</label>
      </div>
    </dialog>`);
  const duplicateIdTopChoiceBlocked = await detectTopChoiceBlocked(page);
  check('Top Choice detection uses the visible label when IDs are reused', () => {
    assert.strictEqual(duplicateIdTopChoiceBlocked, true);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('dialog-mba', 'Is an MBA your highest degree?')}
    </dialog>`);
  const unsafeEducationLabels = new Set();
  await fillDialogRadioGroups(
    page, defaultAnswers, { user: { highestEducation: "Master's Degree" } },
    noopLogger, 'dialog-education-job', {
      runId: 'fixture-run',
      guardBlockedLabels: unsafeEducationLabels,
    }
  );
  const unsafeEducationSelected = await page.locator('#dialog-mba [role="radio"][aria-checked="true"]').count();
  check('unsafe configured education mapping stays unanswered and guard-classified', () => {
    assert.strictEqual(unsafeEducationSelected, 0);
    assert([...unsafeEducationLabels].some((label) => label.includes('MBA')),
      `expected guarded MBA label, got: ${JSON.stringify([...unsafeEducationLabels])}`);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('dialog-degree-threshold', 'Do you have at least a bachelor degree?')}
    </dialog>`);
  const thresholdEducationLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { highestEducation: "Master's Degree" } },
    noopLogger, 'dialog-degree-threshold-job', {
      runId: 'fixture-run', guardBlockedLabels: thresholdEducationLabels,
    }
  );
  const thresholdEducationYes = await page.locator(
    '#dialog-degree-threshold [role="radio"][aria-label="Yes"]'
  ).getAttribute('aria-checked');
  check('configured highest education safely answers an explicit degree threshold', () => {
    assert.strictEqual(thresholdEducationYes, 'true');
    assert.deepStrictEqual([...thresholdEducationLabels], []);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup('dialog-negated-degree', "Do you not have a bachelor's degree?")}
    </dialog>`);
  const negatedEducationLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { highestEducation: "Bachelor's Degree" } },
    noopLogger, 'dialog-negated-degree-job', {
      runId: 'fixture-run', guardBlockedLabels: negatedEducationLabels,
    }
  );
  const negatedEducationSelected = await page.locator(
    '#dialog-negated-degree [role="radio"][aria-checked="true"]'
  ).count();
  check('negated education questions are not rank-mapped', () => {
    assert.strictEqual(negatedEducationSelected, 0);
    assert.strictEqual(negatedEducationLabels.size, 1);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      ${dialogRadioGroup(
        'dialog-compound-degree',
        "Do you have at least a bachelor's degree and 5 years of Python experience?"
      )}
    </dialog>`);
  const compoundEducationLabels = new Set();
  await fillDialogRadioGroups(
    page, {}, { user: { highestEducation: "Bachelor's Degree" } },
    noopLogger, 'dialog-compound-degree-job', {
      runId: 'fixture-run', guardBlockedLabels: compoundEducationLabels,
    }
  );
  const compoundEducationSelected = await page.locator(
    '#dialog-compound-degree [role="radio"][aria-checked="true"]'
  ).count();
  check('degree config does not answer an education-and-experience compound', () => {
    assert.strictEqual(compoundEducationSelected, 0);
    assert.strictEqual(compoundEducationLabels.size, 1);
  });

  const unconfirmedSubmit = await waitForSubmissionConfirmation(page, 50);
  await page.evaluate(() => {
    setTimeout(() => document.querySelector('dialog[open]')?.removeAttribute('open'), 25);
  });
  const closedDialogConfirmation = await waitForSubmissionConfirmation(page, 100);
  const legacyNoEvidence = await waitForSubmissionConfirmation(page, 50);

  check('submission confirmation rejects an unchanged active dialog', () => {
    assert.strictEqual(unconfirmedSubmit, false);
  });

  check('dialog closure alone is not submission confirmation', () => {
    assert.strictEqual(closedDialogConfirmation, false);
  });

  check('legacy flow does not treat absence of a dialog as confirmation', () => {
    assert.strictEqual(legacyNoEvidence, false);
  });

  await page.setContent('<div id="interop-outlet"></div>');
  await page.evaluate(() => {
    const host = document.querySelector('#interop-outlet');
    host.attachShadow({ mode: 'open' }).innerHTML = '<div>Your application was sent</div>';
  });
  const shadowSuccessConfirmation = await waitForSubmissionConfirmation(page, 100);
  check('legacy shadow flow accepts explicit success text', () => {
    assert.strictEqual(shadowSuccessConfirmation, true);
  });

  await page.setContent(`
    <button id="page-dismiss" aria-label="Dismiss">Dismiss job card</button>
    <dialog open><button id="active-dismiss" aria-label="Dismiss">Dismiss</button></dialog>`);
  const visibleDismiss = await firstVisibleApplyControl(page, 'button[aria-label="Dismiss"]');
  const visibleDismissId = await visibleDismiss.getAttribute('id');
  check('cleanup scopes Dismiss to the active apply dialog', () => {
    assert.strictEqual(visibleDismissId, 'active-dismiss');
  });

  await page.setContent(`
    <dialog open><button aria-label="Dismiss">Dismiss</button></dialog>
    <dialog open><button id="discard-confirmation">Discard</button></dialog>`);
  const obscuredDismiss = await firstVisibleApplyControl(page, 'button[aria-label="Dismiss"]');
  const visibleDiscard = await firstVisibleApplyControl(page, 'button:has-text("Discard")');
  const visibleDiscardId = await visibleDiscard.getAttribute('id');
  check('cleanup finds controls in the topmost confirmation dialog', () => {
    assert.strictEqual(obscuredDismiss, null);
    assert.strictEqual(visibleDiscardId, 'discard-confirmation');
  });

  await page.setContent(`
    <dialog open>
      <button id="already-open-discard" onclick="this.dataset.clicked='true'">Discard</button>
    </dialog>`);
  await dismissActiveApplyUi(page);
  const alreadyOpenDiscardClicked = await page.locator('#already-open-discard').getAttribute('data-clicked');
  check('cleanup handles an already-open discard confirmation', () => {
    assert.strictEqual(alreadyOpenDiscardClicked, 'true');
  });

  await page.setContent(`
    <dialog id="underlying-cleanup" open>
      <button id="underlying-discard" onclick="this.dataset.clicked='true'">Discard</button>
    </dialog>
    <dialog id="top-cleanup" open>
      <button aria-label="Dismiss" onclick="this.closest('dialog').remove()">Dismiss</button>
    </dialog>`);
  await dismissActiveApplyUi(page);
  const underlyingDiscardClicked = await page.locator('#underlying-discard').getAttribute('data-clicked');
  check('cleanup never reaches through a closed top dialog to retained Discard', () => {
    assert.strictEqual(underlyingDiscardClicked, null);
  });

  await page.setContent(`
    <dialog id="modal-a"><button id="modal-a-action">Next</button></dialog>
    <dialog id="modal-b"><button id="modal-b-action">Next</button></dialog>`);
  await page.evaluate(() => {
    document.querySelector('#modal-b').showModal();
    document.querySelector('#modal-a').showModal();
  });
  const markedNativeModal = await markActiveApplyDialog(page);
  const markedNativeModalId = await page.locator(
    'dialog[data-agent-active-apply="true"]'
  ).getAttribute('id');
  const nativeModalAction = await firstVisibleApplyControl(page, 'button');
  const nativeModalActionId = await nativeModalAction.getAttribute('id');
  check('native modal activation order wins over reverse DOM order', () => {
    assert.strictEqual(markedNativeModal, true);
    assert.strictEqual(markedNativeModalId, 'modal-a');
    assert.strictEqual(nativeModalActionId, 'modal-a-action');
  });

  await page.setContent(`
    <style>
      dialog { position: fixed; inset: 40px auto auto 40px; margin: 0; width: 240px; height: 120px; }
      #under-layer { z-index: 1; }
      #top-layer { z-index: 2; }
    </style>
    <dialog id="under-layer" open><button id="under-action">Next</button></dialog>
    <dialog id="top-layer" open><button id="top-action">Next</button></dialog>`);
  await page.locator('#under-action').focus();
  const visualLayerControl = await firstVisibleApplyControl(page, 'button');
  const visualLayerControlId = await visualLayerControl.getAttribute('id');
  check('visual top layer wins over stale focus in an underlying non-modal dialog', () => {
    assert.strictEqual(visualLayerControlId, 'top-action');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <label for="volatile-city">City</label>
      <input id="volatile-city" type="text" onclick="this.remove()">
      <button id="volatile-submit"
              onclick="this.dataset.clicked='true'; this.closest('dialog').insertAdjacentHTML('beforeend', '<div>Application submitted</div>')">
        Submit application
      </button>
    </dialog>`);
  const volatileFillResult = await handleInlineApplyStep(
    page, { city: 'Springfield' }, {}, noopLogger, 'volatile-fill-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  const volatileSubmitClicked = await page.locator('#volatile-submit').getAttribute('data-clicked');
  check('form-fill exceptions prevent advancing to Submit', () => {
    assert.strictEqual(volatileFillResult, 'retry_failed');
    assert.strictEqual(volatileSubmitClicked, null);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <button disabled>Submit application</button>
    </dialog>`);
  const disabledSubmitResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'disabled-submit-job', true, 1, { guardBlockedLabels: new Set() }
  );
  check('dry-run never reports a disabled Submit as ready to submit', () => {
    assert.strictEqual(disabledSubmitResult, 'retry_failed');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="required-top-choice" type="checkbox" required>
      <label for="required-top-choice">Mark this job as a Top Choice</label>
      <button disabled>Submit application</button>
    </dialog>`);
  const requiredTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'never' } } },
    noopLogger, 'required-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  const requiredTopChoiceChecked = await page.locator('#required-top-choice').isChecked();
  check('required Top Choice respects never-spend policy and is classified as a skip', () => {
    assert.strictEqual(requiredTopChoiceChecked, false);
    assert.strictEqual(requiredTopChoiceResult, 'top_choice_required');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="optional-top-choice" type="checkbox">
      <label for="optional-top-choice">Mark this job as a Top Choice</label>
      <label for="missing-answer">Required answer</label>
      <input id="missing-answer" type="text" required>
      <div role="alert">Required answer is missing</div>
      <button disabled>Submit application</button>
    </dialog>`);
  const optionalTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'never' } } },
    noopLogger, 'optional-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('optional Top Choice does not hide an unrelated required-field failure', () => {
    assert.strictEqual(optionalTopChoiceResult, 'retry_failed');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="prechecked-top-choice" type="checkbox" checked>
      <label for="prechecked-top-choice">Mark this job as a Top Choice</label>
      <button onclick="this.closest('dialog').insertAdjacentHTML('beforeend', '<div>Your application was sent</div>')">Submit application</button>
    </dialog>`);
  const precheckedTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'never' } } },
    noopLogger, 'prechecked-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 250 }
  );
  const precheckedTopChoiceChecked = await page.locator('#prechecked-top-choice').isChecked();
  check('prechecked dialog Top Choice is cleared before submission', () => {
    assert.strictEqual(precheckedTopChoiceChecked, false);
    assert.strictEqual(precheckedTopChoiceResult, 'submitted');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="rerendered-top-choice" type="checkbox" checked
             onclick="setTimeout(() => { this.checked = true; }, 400)">
      <label for="rerendered-top-choice">Mark this job as a Top Choice</label>
      <button id="rerender-submit" onclick="this.dataset.clicked='true'">Submit application</button>
    </dialog>`);
  const rerenderedTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'never' } } },
    noopLogger, 'rerendered-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  const rerenderedSubmitClicked = await page.locator('#rerender-submit').getAttribute('data-clicked');
  check('pre-submit invariant blocks an asynchronously reselected Top Choice', () => {
    assert.strictEqual(rerenderedTopChoiceResult, 'top_choice_required');
    assert.strictEqual(rerenderedSubmitClicked, null);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <div style="display:none"><span id="aria-top-choice-name">Stale preference</span></div>
      <span id="aria-top-choice-name">Mark this job as a Top Choice</span>
      <input id="aria-never-top-choice" type="checkbox" checked
             aria-labelledby="aria-top-choice-name"
             onclick="setTimeout(() => { this.checked = true; }, 400)">
      <button id="aria-never-submit" onclick="this.dataset.clicked='true'">Submit application</button>
    </dialog>`);
  const ariaNeverTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'never' } } },
    noopLogger, 'aria-never-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  const ariaNeverSubmitClicked = await page.locator('#aria-never-submit').getAttribute('data-clicked');
  check('pre-submit invariant resolves duplicate-id aria-labelledby Top Choice names', () => {
    assert.strictEqual(ariaNeverTopChoiceResult, 'top_choice_required');
    assert.strictEqual(ariaNeverSubmitClicked, null);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="hidden-always-top-choice" type="checkbox" style="display:none">
      <label for="hidden-always-top-choice">Mark this job as a Top Choice</label>
      <button onclick="this.closest('dialog').insertAdjacentHTML('beforeend', '<div>Application submitted</div>')">
        Submit application
      </button>
    </dialog>`);
  const hiddenAlwaysTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'always' } } },
    noopLogger, 'hidden-always-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 250 }
  );
  const hiddenAlwaysTopChoiceChecked = await page.locator('#hidden-always-top-choice').isChecked();
  check('always policy activates a hidden Top Choice input through its visible label', () => {
    assert.strictEqual(hiddenAlwaysTopChoiceChecked, true);
    assert.strictEqual(hiddenAlwaysTopChoiceResult, 'submitted');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="reset-always-top-choice" type="checkbox" style="display:none"
             onclick="setTimeout(() => { this.checked = false; }, 400)">
      <label for="reset-always-top-choice">Mark this job as a Top Choice</label>
      <button id="reset-always-submit" onclick="this.dataset.clicked='true'">Submit application</button>
    </dialog>`);
  const resetAlwaysTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'always' } } },
    noopLogger, 'reset-always-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  const resetAlwaysSubmitClicked = await page.locator('#reset-always-submit').getAttribute('data-clicked');
  check('pre-submit invariant blocks an asynchronously cleared always-policy Top Choice', () => {
    assert.strictEqual(resetAlwaysTopChoiceResult, 'retry_failed');
    assert.strictEqual(resetAlwaysSubmitClicked, null);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="aria-always-top-choice" type="checkbox"
             aria-label="Mark this job as a Top Choice"
             onclick="setTimeout(() => { this.checked = false; }, 400)">
      <button id="aria-always-submit" onclick="this.dataset.clicked='true'">Submit application</button>
    </dialog>`);
  const ariaAlwaysTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'always' } } },
    noopLogger, 'aria-always-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  const ariaAlwaysSubmitClicked = await page.locator('#aria-always-submit').getAttribute('data-clicked');
  check('pre-submit invariant recognizes aria-label Top Choice controls under always policy', () => {
    assert.strictEqual(ariaAlwaysTopChoiceResult, 'retry_failed');
    assert.strictEqual(ariaAlwaysSubmitClicked, null);
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <input id="disabled-always-top-choice" type="checkbox" disabled>
      <label for="disabled-always-top-choice">Mark this job as a Top Choice</label>
      <button>Submit application</button>
    </dialog>`);
  const disabledAlwaysTopChoiceResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'always' } } },
    noopLogger, 'disabled-always-top-choice-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('always-policy control failure is an automation failure, not never-spend skip', () => {
    assert.strictEqual(disabledAlwaysTopChoiceResult, 'retry_failed');
  });

  await page.setContent(`
    <div id="interop-outlet" style="display:none"></div>
    <dialog open>
      <div>1/1 pages</div>
      <button disabled>Submit application</button>
    </dialog>`);
  await page.evaluate(() => {
    document.querySelector('#interop-outlet').attachShadow({ mode: 'open' }).innerHTML = `
      <input id="stale-shadow-top-choice" type="checkbox">
      <label for="stale-shadow-top-choice">Mark this job as a Top Choice</label>`;
  });
  const staleShadowResult = await handleInlineApplyStep(
    page, {}, { platformPolicy: { linkedin: { topChoice: 'always' } } },
    noopLogger, 'stale-shadow-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  const staleShadowChecked = await page.evaluate(() =>
    document.querySelector('#interop-outlet').shadowRoot.querySelector('#stale-shadow-top-choice').checked
  );
  check('visible dialog prevents mutation of a retained legacy shadow form', () => {
    assert.strictEqual(staleShadowChecked, false);
    assert.strictEqual(staleShadowResult, 'retry_failed');
  });

  await page.setContent(`
    <dialog open>
      <div>1/3 pages</div>
      <button id="preview-resume" onclick="this.dataset.clicked='true'">Preview resume</button>
      <button id="review-progress" onclick="this.dataset.clicked='true'">Review application 2 of 3 pages</button>
    </dialog>`);
  const anchoredReviewResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'anchored-review-job', false, 1,
    { guardBlockedLabels: new Set() }
  );
  const previewClicked = await page.locator('#preview-resume').getAttribute('data-clicked');
  const reviewClicked = await page.locator('#review-progress').getAttribute('data-clicked');
  check('progress-suffixed Review does not collide with Preview resume', () => {
    assert.strictEqual(anchoredReviewResult, 'next');
    assert.strictEqual(previewClicked, null);
    assert.strictEqual(reviewClicked, 'true');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').removeAttribute('open')">Submit application</button>
    </dialog>`);
  const closeOnlySubmitResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'close-only-submit-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('submit dialog closure without success evidence is not recorded as submitted', () => {
    assert.strictEqual(closeOnlySubmitResult, 'submit_unconfirmed');
  });

  await page.setContent(`
    <div>Application submitted</div>
    <dialog open>
      <div>1/1 pages</div>
      <button>Submit application</button>
    </dialog>`);
  const staleSuccessSubmitResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'stale-success-submit-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('pre-existing success text cannot confirm the current submission', () => {
    assert.strictEqual(staleSuccessSubmitResult, 'submit_unconfirmed');
  });

  await page.setContent(`
    <div id="stale-success">Application submitted</div>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="document.querySelector('#stale-success').remove(); document.body.insertAdjacentHTML('afterbegin', '<div id=&quot;stale-success&quot;>Application submitted</div>')">Submit application</button>
    </dialog>`);
  const recreatedStaleSuccessResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'recreated-stale-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('recreated identical stale success text cannot confirm submission', () => {
    assert.strictEqual(recreatedStaleSuccessResult, 'submit_unconfirmed');
  });

  await page.setContent(`
    <div id="timed-stale-success">Application submitted 1 minute ago</div>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="document.querySelector('#timed-stale-success').remove(); document.body.insertAdjacentHTML('afterbegin', '<div id=&quot;timed-stale-success&quot;>Application submitted 2 minutes ago</div>')">Submit application</button>
    </dialog>`);
  const changedStaleSuccessResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'changed-stale-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('dynamic text changes do not turn stale success evidence into confirmation', () => {
    assert.strictEqual(changedStaleSuccessResult, 'submit_unconfirmed');
  });

  await page.setContent(`
    <dialog open>
      <div>Application submitted</div>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').insertAdjacentHTML('afterend', '<dialog open><div>Processing</div></dialog>')">Submit application</button>
    </dialog>`);
  const backgroundedStaleSuccessResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'backgrounded-stale-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('opening a new modal does not turn stale dialog success into confirmation', () => {
    assert.strictEqual(backgroundedStaleSuccessResult, 'submit_unconfirmed');
  });

  await page.setContent(`
    <div id="phrase-stale-success">Your application was sent</div>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="document.querySelector('#phrase-stale-success').remove(); document.body.insertAdjacentHTML('afterbegin', '<div>Application submitted</div>')">Submit application</button>
    </dialog>`);
  const changedPhraseSuccessResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'changed-phrase-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('success-phrase transitions do not manufacture new confirmation evidence', () => {
    assert.strictEqual(changedPhraseSuccessResult, 'submit_unconfirmed');
  });

  await page.setContent(`
    <div id="movable-stale-success">Application submitted</div>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').prepend(document.querySelector('#movable-stale-success'))">Submit application</button>
    </dialog>`);
  const movedStaleSuccessResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'moved-stale-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('moving stale success evidence between roots does not confirm submission', () => {
    assert.strictEqual(movedStaleSuccessResult, 'submit_unconfirmed');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="document.body.insertAdjacentHTML('beforeend', '<article data-job-id=&quot;other-job&quot;><div>Application submitted</div></article>')">Submit application</button>
    </dialog>`);
  const unrelatedResultSuccess = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'unrelated-result-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('success text in an unrelated job result cannot confirm submission', () => {
    assert.strictEqual(unrelatedResultSuccess, 'submit_unconfirmed');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="document.body.insertAdjacentHTML('beforeend', '<div role=&quot;article&quot;><span role=&quot;status&quot;>Application submitted</span></div>')">Submit application</button>
    </dialog>`);
  const roleArticleSuccess = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'role-article-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('live success text in a role=article result cannot confirm submission', () => {
    assert.strictEqual(roleArticleSuccess, 'submit_unconfirmed');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="document.body.insertAdjacentHTML('beforeend', '<div class=&quot;job-card-container&quot;><span aria-live=&quot;polite&quot;>Application submitted</span></div>')">Submit application</button>
    </dialog>`);
  const jobCardLiveSuccess = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'job-card-live-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('live success text in a job-card container cannot confirm submission', () => {
    assert.strictEqual(jobCardLiveSuccess, 'submit_unconfirmed');
  });

  await page.setContent(`
    <dialog id="background-success" open>
      <div id="background-stale-success">Application submitted</div>
    </dialog>
    <dialog id="current-submit" open>
      <div>1/1 pages</div>
      <button onclick="document.querySelector('#background-success').append(document.querySelector('#background-stale-success').cloneNode(true))">Submit application</button>
    </dialog>`);
  const backgroundDialogSuccess = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'background-dialog-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('new success text in a background dialog cannot confirm the active flow', () => {
    assert.strictEqual(backgroundDialogSuccess, 'submit_unconfirmed');
  });

  await page.setContent(`
    <div id="interop-outlet"></div>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="document.querySelector('#interop-outlet').shadowRoot.insertAdjacentHTML('beforeend', '<div>Your application was submitted</div>')">
        Submit application
      </button>
    </dialog>`);
  await page.evaluate(() => {
    document.querySelector('#interop-outlet').attachShadow({ mode: 'open' }).innerHTML = '<div>Retained legacy form</div>';
  });
  const crossRootShadowSuccess = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'cross-root-shadow-success-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('dialog flow cannot be confirmed by retained shadow-root success text', () => {
    assert.strictEqual(crossRootShadowSuccess, 'submit_unconfirmed');
  });

  await page.setContent(`
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').insertAdjacentHTML('beforeend', '<div>Your application was sent</div>')">Submit application</button>
    </dialog>`);
  const explicitSuccessSubmitResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, 'confirmed-submit-job', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 250 }
  );
  check('new explicit success text confirms the current submission', () => {
    assert.strictEqual(explicitSuccessSubmitResult, 'submitted');
  });

  await page.goto('about:blank?currentJobId=1234567890');
  await page.setContent(`
    <main><div>Selected job detail</div></main>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').remove(); document.querySelector('main').insertAdjacentHTML('beforeend', '<section><h2>Application status</h2><p>Application submitted</p><span>now</span></section>')">
        Submit application
      </button>
    </dialog>`);
  const detailPanelSubmitResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, '1234567890', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 250 }
  );
  check('new current-job detail-panel status confirms submission', () => {
    assert.strictEqual(detailPanelSubmitResult, 'submitted');
  });

  await page.goto('about:blank?currentJobId=9999999999');
  await page.setContent(`
    <main><div>Different selected job</div></main>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').remove(); document.querySelector('main').insertAdjacentHTML('beforeend', '<section><h2>Application status</h2><p>Application submitted</p></section>')">
        Submit application
      </button>
    </dialog>`);
  const wrongJobDetailResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, '1234567890', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('another job detail status cannot confirm the submitted job', () => {
    assert.strictEqual(wrongJobDetailResult, 'submit_unconfirmed');
  });

  await page.goto('about:blank?currentJobId=1234567890');
  await page.setContent(`
    <main><section><h2>Application status</h2><p>Application submitted</p><span>earlier</span></section></main>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').remove()">Submit application</button>
    </dialog>`);
  const preexistingDetailResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, '1234567890', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 50 }
  );
  check('pre-existing current-job detail status is not new confirmation', () => {
    assert.strictEqual(preexistingDetailResult, 'submit_unconfirmed');
  });

  await page.goto('about:blank?currentJobId=1234567890');
  await page.setContent(`
    <main>
      <div>Selected job detail</div>
      <div data-job-id="other-listing"><h2>Application status</h2><p>Application submitted</p></div>
    </main>
    <dialog open>
      <div>1/1 pages</div>
      <button onclick="this.closest('dialog').remove()">Submit application</button>
    </dialog>`);
  const unrelatedCardDetailResult = await handleInlineApplyStep(
    page, {}, {}, noopLogger, '1234567890', false, 1,
    { guardBlockedLabels: new Set(), submissionConfirmationTimeout: 250 }
  );
  check('detail status inside another result card cannot confirm even with a matching URL', () => {
    assert.strictEqual(unrelatedCardDetailResult, 'submit_unconfirmed');
  });

  await page.goto('about:blank');
  await page.setContent(`
    <dialog open>
      <div>1/2 pages</div>
      <p>Are you willing to relocate?*</p>
      <fieldset role="radiogroup">
        <div role="radio" aria-label="Yes" aria-checked="false">Yes</div>
        <div role="radio" aria-label="No" aria-checked="false">No</div>
      </fieldset>
    </dialog>`);
  const inertRadioGuardLabels = new Set();
  const inertRadioResult = await fillDialogRadioGroups(
    page, defaultAnswers, config, noopLogger, 'inert-radio-job',
    { guardBlockedLabels: inertRadioGuardLabels }
  );
  check('a radio click that never selects is recorded as an unfilled guard label', () => {
    assert.strictEqual(inertRadioResult.filled, 0);
    assert.strictEqual(inertRadioGuardLabels.size, 1);
    assert.ok([...inertRadioGuardLabels][0].includes('relocate'));
  });

  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FIXTURE HARNESS FAILED:', err);
  process.exit(1);
});
