#!/usr/bin/env node
'use strict';

/**
 * benchmark.js — Standalone read-only reporting tool for the Job Apply Agent.
 *
 * Usage:
 *   node benchmark.js              # Last 7 days (default)
 *   node benchmark.js --days 30    # Custom window
 *   node benchmark.js --run latest # Most recent run only
 *   node benchmark.js --run <uuid> # Specific run by ID
 *   node benchmark.js --all        # All time
 *   node benchmark.js --help       # Show usage
 *
 * This script is read-only — it never modifies application data.
 * It opens its own direct SQLite connection (no lib/ imports).
 */

const path = require('path');
const fs = require('fs');

const HELP = `
Usage: node benchmark.js [options]

Options:
  --days <n>     Report window in days (default: 7)
  --run latest   Show most recent run only
  --run <uuid>   Show a specific run by ID
  --all          Show all-time data
  --help         Show this help message
`.trim();

// ── CLI parsing ──
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(HELP); process.exit(0); }

let mode = 'days'; // 'days' | 'run' | 'all'
let days = 7;
let runId = null;

if (args.includes('--all')) {
  mode = 'all';
} else if (args.includes('--run')) {
  mode = 'run';
  runId = args[args.indexOf('--run') + 1];
  if (!runId) { console.error('Error: --run requires a value (uuid or "latest")'); process.exit(2); }
} else if (args.includes('--days')) {
  const val = parseInt(args[args.indexOf('--days') + 1], 10);
  if (isNaN(val) || val < 1) { console.error('Error: --days requires a positive integer'); process.exit(2); }
  days = val;
}

// ── Database connection ──
const dbPath = path.join(__dirname, 'db', 'applications.db');
if (!fs.existsSync(dbPath)) {
  console.log('No application data found. Run the agent first: node index.js');
  process.exit(0);
}

const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });

// Safe migration check — add skipReason if missing (read-only open won't
// allow ALTER, so we just note it in the report)
const columns = db.pragma('table_info(applications)').map(c => c.name);
const hasSkipReason = columns.includes('skipReason');

// ── Resolve run ID for --run mode ──
if (mode === 'run') {
  if (runId === 'latest') {
    const row = db.prepare('SELECT id FROM runs ORDER BY startedAt DESC LIMIT 1').get();
    if (!row) { console.log('No runs found in database.'); process.exit(0); }
    runId = row.id;
  }
  // Verify run exists
  const runRow = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
  if (!runRow) { console.error(`Error: run "${runId}" not found.`); process.exit(2); }
}

// ── Build WHERE clause ──
function dateFilter(col) {
  if (mode === 'all') return { sql: '1=1', params: [] };
  if (mode === 'run') return { sql: `runId = ?`, params: [runId] };
  return { sql: `${col} >= date('now', '-' || ? || ' days')`, params: [days] };
}

// For the runs table, runId maps to the id column
function runsFilter() {
  if (mode === 'all') return { sql: '1=1', params: [] };
  if (mode === 'run') return { sql: `id = ?`, params: [runId] };
  return { sql: `startedAt >= date('now', '-' || ? || ' days')`, params: [days] };
}

// ── Queries ──
function coreMetrics() {
  const f = dateFilter('appliedAt');
  const row = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'submitted' THEN 1 END) as submitted,
      COUNT(CASE WHEN status = 'dry_run' THEN 1 END) as dry_run,
      COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
      COUNT(CASE WHEN status IN ('submitted', 'dry_run', 'error') THEN 1 END) as attempted
    FROM applications WHERE ${f.sql}
  `).get(...f.params);

  const avgRow = db.prepare(`
    SELECT AVG(cnt) as avg FROM (
      SELECT runId, COUNT(*) as cnt FROM applications
      WHERE status IN ('submitted', 'dry_run') AND ${f.sql}
      GROUP BY runId
    )
  `).get(...f.params);

  const rf = runsFilter();
  const durationRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN completedAt IS NOT NULL THEN 1 END) as completed,
      AVG(CASE WHEN completedAt IS NOT NULL
        THEN (julianday(completedAt) - julianday(startedAt)) * 24 * 60
      END) as avg_minutes
    FROM runs WHERE ${rf.sql}
  `).get(...rf.params);

  return {
    submitted: (row?.submitted || 0) + (row?.dry_run || 0),
    errors: row?.errors || 0,
    attempted: row?.attempted || 0,
    avgPerRun: avgRow?.avg || 0,
    runs: durationRow?.total || 0,
    completedRuns: durationRow?.completed || 0,
    avgMinutes: durationRow?.avg_minutes || 0,
  };
}

function skipAnalysis() {
  if (!hasSkipReason) return [];
  const f = dateFilter('appliedAt');
  return db.prepare(`
    SELECT skipReason, COUNT(*) as cnt
    FROM applications
    WHERE status IN ('skipped', 'already_applied') AND skipReason IS NOT NULL AND ${f.sql}
    GROUP BY skipReason
    ORDER BY cnt DESC
  `).all(...f.params);
}

function fieldCoverage() {
  // unfilled_fields has no runId column — for --run mode, filter by
  // the run's start/end timestamps instead.
  if (mode === 'run') {
    return db.prepare(`
      SELECT fieldLabel, COUNT(*) as cnt
      FROM unfilled_fields
      WHERE timestamp >= (SELECT startedAt FROM runs WHERE id = ?)
        AND timestamp <= COALESCE((SELECT completedAt FROM runs WHERE id = ?), datetime('now'))
      GROUP BY fieldLabel ORDER BY cnt DESC LIMIT 10
    `).all(runId, runId);
  }
  const f = dateFilter('timestamp');
  return db.prepare(`
    SELECT fieldLabel, COUNT(*) as cnt
    FROM unfilled_fields
    WHERE ${f.sql}
    GROUP BY fieldLabel
    ORDER BY cnt DESC
    LIMIT 10
  `).all(...f.params);
}

function dailyTrend() {
  const f = dateFilter('appliedAt');
  return db.prepare(`
    SELECT
      DATE(appliedAt) as date,
      COUNT(CASE WHEN status IN ('submitted', 'dry_run') THEN 1 END) as applied,
      COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
      COUNT(CASE WHEN status IN ('skipped', 'already_applied') THEN 1 END) as skipped
    FROM applications
    WHERE ${f.sql}
    GROUP BY DATE(appliedAt)
    ORDER BY date DESC
  `).all(...f.params);
}

// ── Format output ──
function pct(num, den) {
  if (den === 0) return '  0.0%';
  return ((num / den) * 100).toFixed(1).padStart(5) + '%';
}

function padRight(str, len) { return (str || '').padEnd(len); }

// ── Generate report ──
const metrics = coreMetrics();
const skips = skipAnalysis();
const fields = fieldCoverage();
const trend = dailyTrend();

if (metrics.attempted === 0 && skips.length === 0 && trend.length === 0) {
  console.log('No application data found for the selected period. Run the agent first.');
  process.exit(0);
}

// Period label
let periodLabel;
if (mode === 'run') periodLabel = `Run: ${runId}`;
else if (mode === 'all') periodLabel = 'All time';
else {
  const now = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  periodLabel = `${from} → ${now} (last ${days} days)`;
}

const crashedRuns = metrics.runs - metrics.completedRuns;

const lines = [
  '═'.repeat(55),
  '  AGENT BENCHMARK REPORT',
  `  Period: ${periodLabel}`,
  `  Runs: ${metrics.runs} total | ${metrics.completedRuns} completed | ${crashedRuns} crashed`,
  '═'.repeat(55),
  '',
  '  CORE METRICS',
  '  ' + '─'.repeat(50),
  `  Submit Rate ........... ${metrics.submitted}/${metrics.submitted + metrics.errors}  ${pct(metrics.submitted, metrics.submitted + metrics.errors)}  (submitted / submitted+errors)`,
  `  Modal Success Rate .... ${metrics.submitted}/${metrics.attempted}  ${pct(metrics.submitted, metrics.attempted)}  (submitted / attempted)`,
  `  Avg Applications/Run .. ${metrics.avgPerRun.toFixed(1)}`,
  `  Avg Run Duration ...... ${Math.round(metrics.avgMinutes)} min`,
];

if (skips.length > 0) {
  const totalSkips = skips.reduce((s, r) => s + r.cnt, 0);
  lines.push('');
  lines.push('  SKIP ANALYSIS (cards examined but not applied)');
  lines.push('  ' + '─'.repeat(50));
  for (const row of skips) {
    const reason = padRight(row.skipReason, 30);
    const p = pct(row.cnt, totalSkips);
    lines.push(`  ${reason} ${String(row.cnt).padStart(4)}  (${p.trim()})`);
  }
}

if (fields.length > 0) {
  const totalOccurrences = fields.reduce((s, r) => s + r.cnt, 0);
  lines.push('');
  lines.push('  FIELD COVERAGE');
  lines.push('  ' + '─'.repeat(50));
  lines.push(`  Unmatched Fields: ${fields.length} unique across ${totalOccurrences} occurrences`);
  for (const row of fields) {
    const label = padRight(`"${row.fieldLabel}"`, 42);
    lines.push(`    ${label} ${row.cnt}x`);
  }
}

if (trend.length > 0) {
  lines.push('');
  lines.push('  DAILY TREND');
  lines.push('  ' + '─'.repeat(50));
  lines.push('  Date        Applied  Errors  Skipped  Rate');
  for (const row of trend) {
    const total = row.applied + row.errors;
    const rate = total > 0 ? pct(row.applied, total).trim() : 'N/A';
    lines.push(`  ${row.date}  ${String(row.applied).padStart(7)}  ${String(row.errors).padStart(6)}  ${String(row.skipped).padStart(7)}  ${rate}`);
  }
}

lines.push('');
lines.push('═'.repeat(55));

console.log(lines.join('\n'));

db.close();
