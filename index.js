#!/usr/bin/env node
'use strict';

/**
 * index.js — Main orchestrator for the Job Apply Agent.
 *
 * Usage:
 *   node index.js                            # Run all enabled platforms
 *   node index.js --dry-run                  # Simulate without submitting
 *   node index.js --platform linkedin        # Run only LinkedIn
 *   node index.js --dry-run --platform dice  # Dry run for Dice only
 */

const path = require('path');
const fs = require('fs');

// Load configuration files
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const defaultAnswers = JSON.parse(fs.readFileSync(path.join(__dirname, 'defaultAnswers.json'), 'utf8'));

// Core libraries
const logger = require('./lib/logger');
const state = require('./lib/state');
const { launchForPlatform, checkLoginStatus } = require('./lib/browser');

// Platform modules
const { applyLinkedIn } = require('./modules/linkedin');
const { applyDice } = require('./modules/dice');
const { applyIndeed } = require('./modules/indeed');
const { applyJobright } = require('./modules/jobright');

// Platform module map
const PLATFORM_MODULES = {
  linkedin: applyLinkedIn,
  dice: applyDice,
  indeed: applyIndeed,
  jobright: applyJobright,
};

const KNOWN_PLATFORMS = new Set(Object.keys(PLATFORM_MODULES));

/**
 * Parse CLI arguments.
 * Exits with code 2 (usage error) if --platform value is not a known platform.
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const platformIdx = args.indexOf('--platform');
  const platformFilter = platformIdx !== -1 ? args[platformIdx + 1]?.toLowerCase() : null;

  if (platformFilter && !KNOWN_PLATFORMS.has(platformFilter)) {
    console.error(`Error: unknown platform "${platformFilter}". Valid options: ${[...KNOWN_PLATFORMS].join(', ')}`);
    process.exit(2);
  }

  return { dryRun, platformFilter };
}

/**
 * Generate and print the daily summary report.
 */
function printSummaryReport(runId, startTime, stats) {
  const duration = Math.round((Date.now() - startTime) / 1000 / 60);
  const today = new Date().toISOString().slice(0, 10);

  const lines = [
    '═'.repeat(55),
    '  JOB APPLICATION AGENT — DAILY REPORT',
    `  Run ID: ${runId}`,
    `  Date: ${today}`,
    `  Duration: ${duration} minutes`,
    '═'.repeat(55),
  ];

  let totalApplied = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const sessionStatus = [];

  for (const [platform, platformStats] of Object.entries(stats)) {
    if (!platformStats) {
      lines.push(`  ${platform.padEnd(10)}: SKIPPED (session expired)`);
      sessionStatus.push(`${platform} ✗ (expired)`);
      continue;
    }
    const { applied = 0, skipped = 0, errors = 0, dry_run = 0 } = platformStats;
    totalApplied += applied + dry_run;
    totalSkipped += skipped;
    totalErrors += errors;

    const statusLine = dry_run > 0
      ? `  ${platform.padEnd(10)}: ${dry_run} dry_run | ${skipped} skipped | ${errors} errors`
      : `  ${platform.padEnd(10)}: ${applied} applied | ${skipped} skipped | ${errors} errors`;
    lines.push(statusLine);
    sessionStatus.push(`${platform} ✓`);
  }

  lines.push('─'.repeat(55));
  lines.push(`  TOTAL:      ${totalApplied} applied | ${totalSkipped} skipped | ${totalErrors} errors`);
  lines.push(`  Sessions:  ${sessionStatus.join(' | ')}`);
  lines.push('═'.repeat(55));

  const report = lines.join('\n');
  console.log('\n' + report + '\n');
  logger.info({ runId, totalApplied, totalSkipped, totalErrors }, 'Run complete');

  return report;
}

/**
 * Ensure all required directories exist.
 */
function ensureDirectories() {
  const dirs = [
    path.join(__dirname, 'db'),
    path.join(__dirname, 'logs'),
    path.join(__dirname, 'logs', 'errors'),
    path.join(__dirname, 'resumes'),
    path.join(__dirname, 'browser-data'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Main execution flow.
 */
async function main() {
  const { dryRun, platformFilter } = parseArgs(process.argv);
  const startTime = Date.now();

  ensureDirectories();

  // Create a new run record in SQLite
  const runId = state.createRun();

  logger.info(
    { runId, dryRun, platformFilter: platformFilter || 'all' },
    `Starting job application run${dryRun ? ' [DRY RUN]' : ''}`
  );

  if (dryRun) {
    logger.info('DRY RUN mode: will take screenshots instead of submitting applications');
  }

  const runStats = {};
  const enabledPlatforms = Object.entries(config.platforms)
    .filter(([name, cfg]) => {
      if (!cfg.enabled) return false;
      if (platformFilter && name !== platformFilter) return false;
      return true;
    })
    .map(([name]) => name);

  if (enabledPlatforms.length === 0) {
    // platformFilter was already validated above, so if we're here it means
    // config has that platform disabled — treat as a configuration error.
    const msg = platformFilter
      ? `Platform "${platformFilter}" is disabled in config.json (set enabled: true to use it).`
      : 'No platforms are enabled in config.json.';
    logger.error({ platformFilter }, msg);
    console.error('Error:', msg);
    process.exit(2);
  }

  logger.info({ platforms: enabledPlatforms }, 'Will process platforms');

  // Process each platform sequentially
  for (const platform of enabledPlatforms) {
    const platformLogger = logger.child({ platform });
    platformLogger.info('Processing platform');

    let context = null;
    let page = null;

    try {
      // Launch persistent browser context for this platform
      // Persistent context = cookies/session survive between runs (loaded from browser-data/<platform>/)
      const headless = config.behavior?.headless !== false;
      const launched = await launchForPlatform(platform, headless);
      context = launched.context;
      page = launched.page;

      // Check if user is still logged in
      const loggedIn = await checkLoginStatus(page, platform);
      if (!loggedIn) {
        platformLogger.warn(
          `Session expired for ${platform}. Skipping. Run: node setup.js --platform ${platform}`
        );
        runStats[platform] = null; // Mark as skipped due to session
        continue;
      }

      platformLogger.info('Session valid — starting application loop');

      // Run the platform-specific apply module
      const applyFn = PLATFORM_MODULES[platform];
      const platformStats = await applyFn(page, config, defaultAnswers, state, runId, platformLogger, dryRun);

      runStats[platform] = platformStats;
      platformLogger.info(platformStats, 'Platform complete');

    } catch (err) {
      // Catch unexpected errors at the platform level — don't crash the whole run
      platformLogger.error({ error: err.message, stack: err.stack }, 'Unexpected platform error');
      runStats[platform] = { applied: 0, skipped: 0, errors: 1 };

    } finally {
      // Always close the browser context when done with a platform
      // This releases resources and saves session state
      if (context) {
        try {
          await context.close();
          platformLogger.debug('Browser context closed');
        } catch (_) {}
      }
    }
  }

  // Save run stats and print summary
  const aggregatedStats = {};
  for (const [platform, stats] of Object.entries(runStats)) {
    if (stats) {
      aggregatedStats[platform] = stats;
    }
  }

  state.completeRun(runId, aggregatedStats);
  printSummaryReport(runId, startTime, runStats);

  process.exit(0);
}

main().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Fatal error in orchestrator');
  console.error('Fatal error:', err.message);
  process.exit(1);
});
