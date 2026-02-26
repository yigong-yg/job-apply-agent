#!/usr/bin/env node
'use strict';

/**
 * index.js — Main orchestrator for the Job Apply Agent.
 *
 * Usage:
 *   node index.js                            # Run all enabled platforms
 *   node index.js --dry-run                  # Simulate without submitting
 *   node index.js --platform linkedin        # Run only LinkedIn
 *   node index.js --max 5                    # Override max applications
 *   node index.js --help                     # Show usage
 *
 * Configuration priority: CLI flags > .env > config.json
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');

// Load configuration files
const configPath = path.join(__dirname, 'config.json');
const answersPath = path.join(__dirname, 'defaultAnswers.json');
if (!fs.existsSync(configPath) || !fs.existsSync(answersPath)) {
  const missing = [!fs.existsSync(configPath) && 'config.json', !fs.existsSync(answersPath) && 'defaultAnswers.json'].filter(Boolean);
  console.error(`Error: missing ${missing.join(' and ')}. Copy from .example templates:\n  cp config.json.example config.json\n  cp defaultAnswers.json.example defaultAnswers.json\nThen fill in your personal details.`);
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const defaultAnswers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));

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

const HELP_TEXT = `
Usage: node index.js [options]

Options:
  --dry-run         Take screenshots instead of submitting (overrides .env DRY_RUN)
  --platform <name> Run specific platform only (overrides .env PLATFORMS)
  --max <number>    Max applications this run (overrides .env MAX_APPLICATIONS)
  --headless        Run in headless mode (overrides .env HEADLESS)
  --help            Show this help message

Configuration priority: CLI flags > .env > config.json
See .env.example for all available environment variables.
`.trim();

/**
 * Parse CLI arguments into a flat object.
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const parsed = {
    dryRun: args.includes('--dry-run') ? true : undefined,
    headless: args.includes('--headless') ? true : undefined,
    platform: undefined,
    max: undefined,
  };

  const platformIdx = args.indexOf('--platform');
  if (platformIdx !== -1) {
    parsed.platform = args[platformIdx + 1]?.toLowerCase();
    if (parsed.platform && !KNOWN_PLATFORMS.has(parsed.platform)) {
      console.error(`Error: unknown platform "${parsed.platform}". Valid options: ${[...KNOWN_PLATFORMS].join(', ')}`);
      process.exit(2);
    }
  }

  const maxIdx = args.indexOf('--max');
  if (maxIdx !== -1) {
    const val = parseInt(args[maxIdx + 1], 10);
    if (isNaN(val) || val < 1) {
      console.error('Error: --max requires a positive integer');
      process.exit(2);
    }
    parsed.max = val;
  }

  return parsed;
}

/**
 * Build the resolved runtime configuration from CLI > .env > config.json.
 */
function resolveRuntime(cli) {
  // Platform filter (CLI > .env > all enabled in config)
  const platformFilter = cli.platform
    || (process.env.PLATFORMS ? process.env.PLATFORMS.split(',').map(s => s.trim()).filter(Boolean)[0] : null)
    || null;

  // Dry run
  const dryRun = cli.dryRun !== undefined
    ? cli.dryRun
    : (process.env.DRY_RUN !== undefined ? process.env.DRY_RUN === 'true' : false);

  // Headless
  const headless = cli.headless !== undefined
    ? cli.headless
    : (process.env.HEADLESS !== undefined ? process.env.HEADLESS === 'true' : (config.behavior?.headless ?? true));

  // Max applications (per platform)
  const maxApplications = cli.max
    || (process.env.MAX_APPLICATIONS ? parseInt(process.env.MAX_APPLICATIONS, 10) : null)
    || null; // null = use platform default from config

  // Delays
  const delayMin = parseInt(process.env.DELAY_MIN_BETWEEN_APPS || 0, 10)
    || config.behavior?.minDelayBetweenApplications || 5000;
  const delayMax = parseInt(process.env.DELAY_MAX_BETWEEN_APPS || 0, 10)
    || config.behavior?.maxDelayBetweenApplications || 15000;

  // Screenshot on error
  const screenshotOnError = process.env.SCREENSHOT_ON_ERROR !== undefined
    ? process.env.SCREENSHOT_ON_ERROR !== 'false'
    : (config.behavior?.screenshotOnError !== false);

  return { platformFilter, dryRun, headless, maxApplications, delayMin, delayMax, screenshotOnError };
}

/**
 * Generate and print the daily summary report.
 * Uses DB-accurate counts (via state.getRunStats) so dry_run vs submitted
 * are correctly distinguished regardless of what in-memory stats return.
 */
async function printSummaryReport(runId, startTime, sessionStats) {
  const duration = Math.round((Date.now() - startTime) / 1000 / 60);
  const today = new Date().toISOString().slice(0, 10);

  // Pull accurate per-status counts from the database
  const dbStats = state.getRunStats(runId);

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

  for (const [platform, sessionStat] of Object.entries(sessionStats)) {
    if (!sessionStat) {
      lines.push(`  ${platform.padEnd(10)}: SKIPPED (session expired)`);
      sessionStatus.push(`${platform} ✗ (expired)`);
      continue;
    }
    const platformStats = dbStats[platform] || { applied: 0, skipped: 0, errors: 0, dry_run: 0 };
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

  const unmatchedCount = state.getUnfilledFieldsCount(runId);

  lines.push('─'.repeat(55));
  lines.push(`  TOTAL:      ${totalApplied} applied | ${totalSkipped} skipped | ${totalErrors} errors`);
  lines.push(`  Sessions:  ${sessionStatus.join(' | ')}`);
  lines.push(`  Unmatched Fields: ${unmatchedCount} new (see unfilled_fields table)`);
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
    path.join(__dirname, 'logs', 'screenshots'),
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
  const cli = parseArgs(process.argv);
  const runtime = resolveRuntime(cli);
  const startTime = Date.now();

  ensureDirectories();

  // Create a new run record in SQLite
  const runId = state.createRun();

  // Log resolved runtime config so the user always knows what's active
  console.log(`Runtime config: max=${runtime.maxApplications || 'per-platform default'}, headless=${runtime.headless}, dryRun=${runtime.dryRun}, platforms=${runtime.platformFilter || 'all enabled'}, delays=${runtime.delayMin}-${runtime.delayMax}ms`);

  logger.info(
    { runId, dryRun: runtime.dryRun, platformFilter: runtime.platformFilter || 'all' },
    `Starting job application run${runtime.dryRun ? ' [DRY RUN]' : ''}`
  );

  if (runtime.dryRun) {
    logger.info('DRY RUN mode: will take screenshots instead of submitting applications');
  }

  // Inject runtime overrides into config so modules read them transparently.
  // This avoids changing every module's function signature.
  config.behavior.minDelayBetweenApplications = runtime.delayMin;
  config.behavior.maxDelayBetweenApplications = runtime.delayMax;
  config.behavior.screenshotOnError = runtime.screenshotOnError;
  config.behavior.headless = runtime.headless;

  const runStats = {};
  const enabledPlatforms = Object.entries(config.platforms)
    .filter(([name, cfg]) => {
      if (!cfg.enabled) return false;
      if (runtime.platformFilter && name !== runtime.platformFilter) return false;
      return true;
    })
    .map(([name]) => name);

  if (enabledPlatforms.length === 0) {
    const msg = runtime.platformFilter
      ? `Platform "${runtime.platformFilter}" is disabled in config.json (set enabled: true to use it).`
      : 'No platforms are enabled in config.json.';
    logger.error({ platformFilter: runtime.platformFilter }, msg);
    console.error('Error:', msg);
    process.exit(2);
  }

  logger.info({ platforms: enabledPlatforms }, 'Will process platforms');

  // Process each platform sequentially
  for (const platform of enabledPlatforms) {
    const platformLogger = logger.child({ platform });
    platformLogger.info('Processing platform');

    // Apply global max override if set, otherwise use per-platform default
    if (runtime.maxApplications) {
      config.platforms[platform].maxApplicationsPerRun = runtime.maxApplications;
    }

    let context = null;
    let page = null;

    try {
      // Launch persistent browser context for this platform
      const launched = await launchForPlatform(platform, runtime.headless);
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
      const platformStats = await applyFn(page, config, defaultAnswers, state, runId, platformLogger, runtime.dryRun);

      runStats[platform] = platformStats;
      platformLogger.info(platformStats, 'Platform complete');

    } catch (err) {
      platformLogger.error({ error: err.message, stack: err.stack }, 'Unexpected platform error');
      runStats[platform] = { applied: 0, skipped: 0, errors: 1 };

    } finally {
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
  await printSummaryReport(runId, startTime, runStats);

  process.exit(0);
}

main().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Fatal error in orchestrator');
  console.error('Fatal error:', err.message);
  process.exit(1);
});
