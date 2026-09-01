'use strict';

const assert = require('assert');
const { chromium } = require('playwright');
const { extractLabel, fillForm, retryInvalidFields } = require('../lib/form-filler');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <dialog open>
        <section style="display: none">
          <label for="shared-field-id">Stale hidden field label</label>
          <input id="shared-field-id">
          <span id="shared-prefix">Stale</span>
          <span id="shared-question">hidden ARIA question</span>
        </section>
        <div>
          <label for="shared-field-id">Current city</label>
          <input id="shared-field-id">
        </div>
        <div>
          <span id="shared-prefix">Current</span>
          <span id="shared-question">state</span>
          <input id="active-aria-field" aria-labelledby="shared-prefix shared-question">
        </div>
      </dialog>`);

    const activeForInput = await page.locator('dialog input#shared-field-id:visible').elementHandle();
    const activeAriaInput = await page.locator('dialog input#active-aria-field').elementHandle();

    assert.strictEqual(
      await extractLabel(page, activeForInput),
      'Current city',
      'label[for] should resolve beside the active ElementHandle, not the hidden duplicate id'
    );
    assert.strictEqual(
      await extractLabel(page, activeAriaInput),
      'Current state',
      'aria-labelledby IDREFs should resolve locally and preserve token order'
    );

    await page.setContent(`
      <div role="option" style="display:none">Springfield</div>
      <div id="city-options" role="listbox">
        <div id="unrelated-city-option" role="option"
             onclick="this.dataset.clicked='true'">Springfield</div>
      </div>
      <dialog open data-agent-active-apply="true">
        <label for="city-combobox">City</label>
        <button id="city-combobox" role="combobox" aria-controls="city-options"
                onclick="document.querySelector('#active-city-option').style.display='block'">Select an option</button>
        <div id="city-options" role="listbox">
          <div id="active-city-option" role="option" style="display:none"
               onclick="document.querySelector('#city-combobox').textContent='Springfield'">Springfield</div>
        </div>
      </dialog>`);
    const dropdownResult = await fillForm(
      page, { city: 'Springfield' }, { user: {} }, noopLogger,
      'linkedin', 'dropdown-fixture', { scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    );
    const selectedCity = await page.locator('#city-combobox').innerText();
    const unrelatedClicked = await page.locator('#unrelated-city-option').getAttribute('data-clicked');
    assert.strictEqual(
      dropdownResult.filledCount,
      1,
      `dropdown result: ${JSON.stringify(dropdownResult)}`
    );
    assert.strictEqual(selectedCity, 'Springfield');
    assert.strictEqual(unrelatedClicked, null);

    await page.setContent(`
      <dialog open data-agent-active-apply="true">
        <label for="state-field">State</label>
        <input id="state-field" type="text">
      </dialog>`);
    const stateResult = await fillForm(
      page,
      { 'are you authorized to work in the united states': 'Yes' },
      { user: { state: 'UT' }, behavior: { typingSpeed: { min: 0, max: 0 } } },
      noopLogger,
      'linkedin',
      'state-fixture',
      { scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    );
    assert.strictEqual(stateResult.filledCount, 1);
    assert.strictEqual(await page.locator('#state-field').inputValue(), 'UT');

    await page.setContent(`
      <div id="location-options" role="listbox">
        <div id="unrelated-autocomplete" role="option"
             onclick="this.dataset.clicked='true'">Springfield</div>
      </div>
      <dialog open data-agent-active-apply="true">
        <label for="city-autocomplete">City</label>
        <input id="city-autocomplete" type="text" aria-controls="location-options"
               oninput="document.querySelector('#active-autocomplete').style.display='block'">
        <div id="location-options" role="listbox">
          <div id="active-autocomplete" role="option" style="display:none"
               onclick="document.querySelector('#city-autocomplete').dataset.selected='true'">Springfield</div>
        </div>
      </dialog>`);
    await fillForm(
      page, { city: 'Springfield' }, { user: {} }, noopLogger,
      'linkedin', 'autocomplete-fixture', { scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    );
    assert.strictEqual(await page.locator('#active-autocomplete').getAttribute('data-selected'), null);
    assert.strictEqual(await page.locator('#city-autocomplete').getAttribute('data-selected'), 'true');
    assert.strictEqual(await page.locator('#unrelated-autocomplete').getAttribute('data-clicked'), null);

    await page.setContent(`
      <dialog open data-agent-active-apply="true">
        <label for="gender-combobox">Gender</label>
        <button id="gender-combobox" role="combobox"
                onclick="this.parentElement.querySelectorAll('[role=option]').forEach((option) => option.style.display='block')">
          Select an option
        </button>
        <div id="gender-female" role="option" style="display:none"
             onclick="this.dataset.clicked='true'">Female</div>
        <div id="gender-male" role="option" style="display:none"
             onclick="this.dataset.clicked='true'">Male</div>
      </dialog>`);
    const genderDropdownResult = await fillForm(
      page, {}, { user: { gender: 'Male' } }, noopLogger,
      'linkedin', 'gender-dropdown-fixture', { scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    );
    assert.strictEqual(genderDropdownResult.filledCount, 1);
    assert.strictEqual(await page.locator('#gender-female').getAttribute('data-clicked'), null);
    assert.strictEqual(await page.locator('#gender-male').getAttribute('data-clicked'), 'true');

    await page.setContent(`
      <dialog open data-agent-active-apply="true">
        <label for="gender-select">Gender</label>
        <select id="gender-select">
          <option value="">Select an option</option>
          <option value="female">Female</option>
        </select>
        <fieldset>
          <legend>Gender</legend>
          <input id="native-female" type="radio" name="native-gender" value="Female">
          <label for="native-female">Female</label>
          <input id="native-male" type="radio" name="native-gender" value="Male">
          <label for="native-male">Male</label>
        </fieldset>
      </dialog>`);
    const nativeGenderResult = await fillForm(
      page, {}, { user: { gender: 'Male' } }, noopLogger,
      'linkedin', 'native-gender-fixture', { scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    );
    assert.strictEqual(nativeGenderResult.filledCount, 1);
    assert.strictEqual(await page.locator('#gender-select').inputValue(), '');
    assert.strictEqual(await page.locator('#native-female').isChecked(), false);
    assert.strictEqual(await page.locator('#native-male').isChecked(), true);

    await page.setContent(`
      <dialog open data-agent-active-apply="true">
        <div>
          <label for="retry-gender-select">Gender</label>
          <select id="retry-gender-select" required aria-invalid="true">
            <option value="">Select an option</option>
            <option value="female">Female</option>
          </select>
          <div role="alert">Please make a selection</div>
        </div>
      </dialog>`);
    const retryGenderResult = await retryInvalidFields(
      page, {}, { user: { gender: 'Male' } }, noopLogger,
      'linkedin', 'retry-gender-fixture', { scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    );
    assert.strictEqual(retryGenderResult.retryFilled, 0);
    assert.strictEqual(await page.locator('#retry-gender-select').inputValue(), '');

    await page.setContent(`
      <section style="display:none">
        <input id="duplicate-consent" type="checkbox">
      </section>
      <dialog open data-agent-active-apply="true">
        <div style="position:relative; width:320px; height:40px">
          <input id="duplicate-consent" type="checkbox" required>
          <label for="duplicate-consent"
                 style="position:absolute; inset:0; background:white">
            I agree to receive marketing communications about jobs
          </label>
        </div>
      </dialog>`);
    const consentResult = await fillForm(
      page, {}, { user: {} }, noopLogger,
      'linkedin', 'consent-fixture', { scopeSelector: 'dialog[data-agent-active-apply="true"]' }
    );
    const duplicateConsentState = await page.locator('input#duplicate-consent').evaluateAll((inputs) =>
      inputs.map((input) => input.checked)
    );
    assert.strictEqual(consentResult.filledCount, 1);
    assert.deepStrictEqual(duplicateConsentState, [false, true]);

    console.log('\n=== Extract Label Tests ===\n');
    console.log('  PASS  active dialog label-for ignores hidden duplicate ids');
    console.log('  PASS  active dialog aria-labelledby resolves local ordered IDREFs');
    console.log('  PASS  custom dropdown binds to the newly opened active option');
    console.log('  PASS  short State label prefers configured address rule');
    console.log('  PASS  autocomplete binds to the active duplicate-id listbox');
    console.log('  PASS  guarded custom dropdown distinguishes Male from Female');
    console.log('  PASS  guarded native select/radio matching distinguishes Male from Female');
    console.log('  PASS  guarded retry select refuses a Female-only mismatch');
    console.log('  PASS  duplicate-id marketing consent activates the exact checkbox');
    console.log('\n9 passed, 0 failed');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(`\n  FAIL  ${err.message}`);
  process.exit(1);
});
