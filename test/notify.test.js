'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');

// Fake snowflake for mention tests — the real ID lives only in gitignored .env
const FAKE_MEOWFIS_ID = '111111111111111111';

const ORIGINAL_ENV = {
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  DISCORD_AGENT_INTERNAL_WEBHOOK_URL: process.env.DISCORD_AGENT_INTERNAL_WEBHOOK_URL,
  DISCORD_MEOWFIS_USER_ID: process.env.DISCORD_MEOWFIS_USER_ID,
};
const ORIGINAL_FETCH = global.fetch;

function loadNotifyModule({
  webhookUrl = 'https://discord.invalid/notify',
  agentInternalWebhookUrl = 'https://discord.invalid/agent-internal',
  meowfisUserId = FAKE_MEOWFIS_ID,
} = {}) {
  process.env.DISCORD_WEBHOOK_URL = webhookUrl;
  process.env.DISCORD_AGENT_INTERNAL_WEBHOOK_URL = agentInternalWebhookUrl;
  process.env.DISCORD_MEOWFIS_USER_ID = meowfisUserId;
  delete require.cache[require.resolve('../lib/notify')];
  return require('../lib/notify');
}

function createLogger() {
  return {
    warn() {},
  };
}

afterEach(() => {
  process.env.DISCORD_WEBHOOK_URL = ORIGINAL_ENV.DISCORD_WEBHOOK_URL;
  process.env.DISCORD_AGENT_INTERNAL_WEBHOOK_URL = ORIGINAL_ENV.DISCORD_AGENT_INTERNAL_WEBHOOK_URL;
  process.env.DISCORD_MEOWFIS_USER_ID = ORIGINAL_ENV.DISCORD_MEOWFIS_USER_ID;
  global.fetch = ORIGINAL_FETCH;
  delete require.cache[require.resolve('../lib/notify')];
});

test('sendSessionSummary marks dry-run mode in content and embed fields', async () => {
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push({ url, payload: JSON.parse(options.body) });
    return { ok: true };
  };

  const { sendSessionSummary } = loadNotifyModule();
  await sendSessionSummary({
    sessionId: 42,
    durationMin: 3,
    scanned: 10,
    applied: 2,
    skipped: 7,
    failed: 1,
    dsCalls: 4,
    topFail: [{ reason: 'captcha_blocked', count: 1 }],
    weekApplied: 12,
    weekTarget: 60,
    dbTotal: 150,
    dryRun: true,
  }, createLogger());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://discord.invalid/notify');
  assert.match(sent[0].payload.content, /mode=dry_run/);
  assert.deepEqual(
    sent[0].payload.embeds[0].fields.find(field => field.name === 'mode'),
    { name: 'mode', value: 'dry_run', inline: true }
  );
});

test('notifyMeowfis sends a structured prod dashboard trigger', async () => {
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push({ url, payload: JSON.parse(options.body) });
    return { ok: true };
  };

  const { notifyMeowfis } = loadNotifyModule();
  await notifyMeowfis({
    dryRun: false,
    sessionId: 8,
    applied: 3,
    scanned: 11,
  }, createLogger());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://discord.invalid/agent-internal');
  assert.equal(
    sent[0].payload.content,
    `<@${FAKE_MEOWFIS_ID}> Session complete — please write dashboard.\n` +
    'type=prod session_id=8 applied=3 scanned=11'
  );
});

test('notifyMeowfis skips dashboard trigger for dry runs', async () => {
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push({ url, payload: JSON.parse(options.body) });
    return { ok: true };
  };

  const { notifyMeowfis } = loadNotifyModule();
  await notifyMeowfis({
    dryRun: true,
    sessionId: 9,
    applied: 1,
    scanned: 5,
  }, createLogger());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://discord.invalid/agent-internal');
  assert.equal(
    sent[0].payload.content,
    'Dry run #9 complete. No dashboard needed. scanned=5 applied=1'
  );
  assert.doesNotMatch(sent[0].payload.content, /please write dashboard/);
});
