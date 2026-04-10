'use strict';

const assert = require('assert');
const path = require('path');

const notifyPath = path.join(__dirname, '..', 'lib', 'notify.js');

function loadNotifyWithEnv(env) {
  const original = process.env.DISCORD_MEOWFIS_USER_ID;
  if (env === undefined) delete process.env.DISCORD_MEOWFIS_USER_ID;
  else process.env.DISCORD_MEOWFIS_USER_ID = env;

  delete require.cache[require.resolve(notifyPath)];
  const mod = require(notifyPath);

  if (original === undefined) delete process.env.DISCORD_MEOWFIS_USER_ID;
  else process.env.DISCORD_MEOWFIS_USER_ID = original;

  delete require.cache[require.resolve(notifyPath)];
  return mod;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

console.log('\n=== Notify Module Tests ===\n');

test('omits a Discord mention when no user id is configured', () => {
  const { buildMeowfisMessage } = loadNotifyWithEnv(undefined);
  const message = buildMeowfisMessage({ sessionId: 7, applied: 2, scanned: 5 });
  assert(!message.startsWith('<@'));
  assert(message.includes('Session complete'));
});

test('includes a Discord mention when a user id is configured', () => {
  const { buildMeowfisMessage } = loadNotifyWithEnv('12345');
  const message = buildMeowfisMessage({ sessionId: 7, applied: 2, scanned: 5 });
  assert(message.startsWith('<@12345> '));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
