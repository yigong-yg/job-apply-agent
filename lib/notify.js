'use strict';

/**
 * lib/notify.js — Send run notifications to Discord.
 *
 * Sends a rich embed to a Discord webhook with the daily run summary.
 * Set DISCORD_WEBHOOK_URL in .env to enable.
 */

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

/**
 * Send the run report to Discord as a rich embed.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {number} opts.totalApplied
 * @param {number} opts.totalSkipped
 * @param {number} opts.totalErrors
 * @param {number} opts.durationMin
 * @param {boolean} opts.dryRun
 * @param {string[]} opts.sessions - e.g. ["linkedin ✓", "indeed ✗"]
 * @param {object} opts.logger
 */
async function sendDiscordNotification(opts) {
  if (!DISCORD_WEBHOOK_URL) return;

  const { runId, totalApplied, totalSkipped, totalErrors, durationMin, dryRun, sessions, logger } = opts;

  const today = new Date().toISOString().slice(0, 10);
  const color = totalErrors > 0 ? 0xff4444 : (totalApplied === 0 ? 0xffaa00 : 0x44bb44);
  const title = dryRun ? 'Job Agent — Daily Report [DRY RUN]' : 'Job Agent — Daily Report';

  const embed = {
    title,
    color,
    fields: [
      { name: 'Date', value: today, inline: true },
      { name: 'Duration', value: `${durationMin} min`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Applied', value: String(totalApplied), inline: true },
      { name: 'Skipped', value: String(totalSkipped), inline: true },
      { name: 'Errors', value: String(totalErrors), inline: true },
      { name: 'Sessions', value: sessions.join(' | ') || 'none', inline: false },
    ],
    footer: { text: `Run ${runId.slice(0, 8)}` },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (logger) logger.warn({ status: res.status, body }, 'Discord notification failed');
    } else {
      if (logger) logger.info('Discord notification sent');
    }
  } catch (err) {
    if (logger) logger.warn({ error: err.message }, 'Discord notification error');
  }
}

/**
 * Send a simple text message to Discord (for guards/skips).
 */
async function sendDiscordMessage(message, logger) {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok && logger) {
      logger.warn({ status: res.status }, 'Discord message failed');
    }
  } catch (err) {
    if (logger) logger.warn({ error: err.message }, 'Discord message error');
  }
}

module.exports = { sendDiscordNotification, sendDiscordMessage };
