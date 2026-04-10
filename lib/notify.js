'use strict';

/**
 * lib/notify.js — Discord notification system v2.
 *
 * Two notification types:
 * 1. Per-application embeds (batched up to 10 per message)
 * 2. Session summary embed (sent at end of run)
 *
 * Designed for dual consumption:
 * - Human (@karlamo): scan status at a glance
 * - AI agent (meowfis): parse channel history for aggregation queries
 */

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_AGENT_INTERNAL_WEBHOOK_URL = process.env.DISCORD_AGENT_INTERNAL_WEBHOOK_URL;
const MEOWFIS_USER_ID = process.env.DISCORD_MEOWFIS_USER_ID || '';

// Status → icon, color, Discord embed color code
const STATUS_MAP = {
  submitted:       { icon: '✅', label: 'APPLIED',  color: 3066993 },
  dry_run:         { icon: '🧪', label: 'DRY RUN',  color: 3066993 },
  skipped:         { icon: '⏭️', label: 'SKIPPED',  color: 16776960 },
  error:           { icon: '❌', label: 'FAILED',   color: 15158332 },
  already_applied: { icon: '🚫', label: 'BLOCKED',  color: 9807270 },
};

// Normalize skipReason/errorMessage to a fixed reason enum
function normalizeReason(status, skipReason, errorMessage) {
  if (status === 'already_applied') return 'already_applied';
  if (skipReason) {
    // Strip dynamic suffixes like "location_filtered:San Jose, CA"
    const base = skipReason.split(':')[0];
    const map = {
      'already_applied_db': 'already_applied',
      'already_applied_linkedin': 'already_applied',
      'no_easy_apply_button': 'not_easy_apply',
      'promoted': 'promoted',
      'daily_limit_reached': 'daily_limit',
      'location_filtered': 'location_filtered',
      'location_unknown': 'location_filtered',
      'form_fill_failed': 'form_timeout',
    };
    return map[base] || base;
  }
  if (errorMessage) {
    if (errorMessage.includes('Timeout')) return 'form_timeout';
    if (errorMessage.includes('not enabled')) return 'daily_limit';
    return 'unknown_error';
  }
  return 'unknown_error';
}

function getSessionMode(dryRun = false) {
  return dryRun ? 'dry_run' : 'prod';
}

/**
 * Build a Discord embed + plain text line for a single application.
 * Text line is machine-readable for Alma/meowfis (can't read embeds).
 */
function buildAppNotification({ status, company, jobTitle, jobId, steps, dsFills, skipReason, errorMessage, sessionId, seq, source }) {
  const s = STATUS_MAP[status] || STATUS_MAP.error;
  const reason = (status !== 'submitted' && status !== 'dry_run')
    ? normalizeReason(status, skipReason, errorMessage) : null;
  const src = source || 'organic';
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Plain text line — meowfis reads this
  const parts = [`${s.icon} ${s.label}`, `company=${company || '?'}`, `role=${jobTitle || '?'}`, `source=${src}`, `steps=${steps || 0}`];
  if (dsFills > 0) parts.push(`ds=${dsFills}`);
  if (reason) parts.push(`reason=${reason}`);
  parts.push(`#${sessionId}-${seq}`);
  const textLine = parts.join(' | ');

  // Embed — human reads this
  const fields = [
    { name: 'role', value: jobTitle || 'N/A', inline: true },
    { name: 'source', value: src, inline: true },
    { name: 'steps', value: String(steps || 0), inline: true },
  ];
  if (dsFills > 0) {
    fields.push({ name: 'ds_fills', value: String(dsFills), inline: true });
  }
  if (reason) {
    fields.push({ name: 'reason', value: reason, inline: false });
  }

  const embed = {
    title: `${s.icon} ${s.label} | ${company || 'Unknown'}`,
    color: s.color,
    fields,
    footer: { text: `#${sessionId}-${seq} | ${now}` },
    url: jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : undefined,
  };

  return { embed, textLine };
}

// ── Batch queue ──
let embedQueue = [];
let textQueue = [];
let flushTimer = null;

async function flushQueue(logger) {
  if (embedQueue.length === 0) return;
  const embeds = embedQueue.splice(0, 10);
  const lines = textQueue.splice(0, 10);
  await sendToDiscord({ content: lines.join('\n'), embeds }, logger);
}

function scheduleFlush(logger) {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushQueue(logger);
  }, 5000); // Flush every 5s or when batch hits 10
}

/**
 * Queue a per-application notification. Batches up to 10 embeds per message.
 */
async function queueAppNotification(opts, logger) {
  if (!DISCORD_WEBHOOK_URL || opts.dryRun) return;
  const { embed, textLine } = buildAppNotification(opts);
  embedQueue.push(embed);
  textQueue.push(textLine);
  if (embedQueue.length >= 10) {
    await flushQueue(logger);
  } else {
    scheduleFlush(logger);
  }
}

/**
 * Flush any remaining queued embeds. Call at end of run.
 */
async function flushAppNotifications(logger) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  while (embedQueue.length > 0) {
    await flushQueue(logger);
  }
}

/**
 * Send session summary notification.
 */
async function sendSessionSummary({ sessionId, durationMin, scanned, applied, skipped, failed, dsCalls, topFail, weekApplied, weekTarget, dbTotal, dryRun }, logger) {
  if (!DISCORD_WEBHOOK_URL || dryRun) return;

  const mode = getSessionMode(dryRun);
  const successRate = (applied + failed) > 0
    ? Math.round(100 * applied / (applied + failed))
    : 100;

  const title = dryRun
    ? `🧪 SESSION #${sessionId} SUMMARY [DRY RUN]`
    : `📊 SESSION #${sessionId} SUMMARY`;

  const fields = [
    { name: 'duration', value: `${durationMin} min`, inline: true },
    { name: 'scanned', value: String(scanned), inline: true },
    { name: 'applied', value: String(applied), inline: true },
    { name: 'skipped', value: String(skipped), inline: true },
    { name: 'failed', value: String(failed), inline: true },
    { name: 'success_rate', value: `${successRate}%`, inline: true },
    { name: 'ds_calls', value: String(dsCalls), inline: true },
    { name: 'mode', value: mode, inline: true },
  ];

  if (topFail && topFail.length > 0) {
    fields.push({
      name: 'top_fail',
      value: topFail.map(f => `${f.reason}:${f.count}`).join('  '),
      inline: false,
    });
  }

  fields.push(
    { name: 'week', value: `${weekApplied}/${weekTarget}`, inline: true },
    { name: 'db_total', value: String(dbTotal), inline: true },
  );

  const today = new Date().toISOString().slice(0, 10);
  const failStr = (topFail && topFail.length > 0) ? topFail.map(f => `${f.reason}:${f.count}`).join(' ') : 'none';

  // Plain text for meowfis
  const textContent = [
    `📊 SESSION #${sessionId} | ${today} | mode=${mode}`,
    `duration=${durationMin}min scanned=${scanned} applied=${applied} skipped=${skipped} failed=${failed}`,
    `success_rate=${successRate}% ds_calls=${dsCalls} top_fail=${failStr}`,
    `week=${weekApplied}/${weekTarget} db_total=${dbTotal}`,
  ].join('\n');

  const embed = {
    title,
    color: 3447003,
    fields,
    footer: { text: `${today} | session ended` },
  };

  await sendToDiscord({ content: textContent, embeds: [embed] }, logger);
}

/**
 * Send a simple text message to Discord (for guards/skips).
 */
async function sendDiscordMessage(message, logger) {
  if (!DISCORD_WEBHOOK_URL) return;
  await sendToDiscord({ content: message }, logger);
}

/**
 * Notify Meowfis in #agent-internal.
 *
 * Prod runs trigger dashboard generation. Dry runs emit a status-only message.
 */
function buildMeowfisMessage({ dryRun = false, sessionId, applied = 0, scanned = 0 } = {}) {
  if (dryRun) {
    return `Dry run #${sessionId} complete. No dashboard needed. scanned=${scanned} applied=${applied}`;
  }

  const mention = MEOWFIS_USER_ID ? `<@${MEOWFIS_USER_ID}> ` : '';
  return `${mention}Session complete — please write dashboard.\n` +
    `type=${getSessionMode(dryRun)} session_id=${sessionId} applied=${applied} scanned=${scanned}`;
}

async function notifyMeowfis(opts = {}, logger) {
  if (!DISCORD_AGENT_INTERNAL_WEBHOOK_URL) return;

  await sendToWebhook(DISCORD_AGENT_INTERNAL_WEBHOOK_URL, {
    content: buildMeowfisMessage(opts),
  }, logger);
}



/**

 * Low-level Discord webhook POST.

 */

async function sendToDiscord(payload, logger) {

  await sendToWebhook(DISCORD_WEBHOOK_URL, payload, logger);

}



/**

 * Low-level Discord webhook POST to a specific webhook URL.

 */

async function sendToWebhook(webhookUrl, payload, logger) {

  try {

    const res = await fetch(webhookUrl, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(payload),

    });

    if (!res.ok) {

      const body = await res.text().catch(() => '');

      if (logger) logger.warn({ status: res.status, body }, 'Discord POST failed');

    }

  } catch (err) {

    if (logger) logger.warn({ error: err.message }, 'Discord POST error');

  }

}

module.exports = {
  queueAppNotification,
  flushAppNotifications,
  sendSessionSummary,
  sendDiscordMessage,
  notifyMeowfis,
  buildMeowfisMessage,
};
