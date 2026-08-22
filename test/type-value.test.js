'use strict';

const assert = require('assert');
const { typeValue } = require('../lib/form-filler');

(async () => {
  let fallbackAttempts = 0;
  const input = {
    async click() { throw new Error('element detached during click'); },
    async fill() {
      fallbackAttempts++;
      throw new Error('fallback fill failed');
    },
  };

  await assert.rejects(
    () => typeValue({}, input, 'answer', { behavior: { typingSpeed: { min: 1, max: 1 } } }),
    /fallback fill failed/
  );
  assert.strictEqual(fallbackAttempts, 1);

  console.log('\n=== Type Value Tests ===\n');
  console.log('  PASS  propagates fallback fill failure instead of auditing a false success');
  console.log('\n1 passed, 0 failed');
})().catch((err) => {
  console.error(`\n  FAIL  ${err.message}`);
  process.exit(1);
});
