'use strict';

/**
 * Choose the orchestrator exit code from its final, DB-backed run totals.
 *
 * Exit code 3 is reserved for an expired session so the launcher can report
 * the actionable re-login state. All other unhealthy runs use exit code 1.
 * Application-level errors only fail production runs when none of the jobs
 * were submitted; dry runs are diagnostic and do not submit by design.
 */
function getRunExitCode({
  dryRun = false,
  totalApplied = 0,
  totalErrors = 0,
  sessionExpired = false,
  platformCrashed = false,
  captchaBlocked = false,
} = {}) {
  if (sessionExpired) return 3;
  if (platformCrashed) return 1;
  if (!dryRun && totalApplied === 0 && captchaBlocked) return 1;
  if (!dryRun && totalApplied === 0 && totalErrors > 0) return 1;
  return 0;
}

/**
 * Per-run application allowance under a cumulative Denver-day ceiling.
 * Every scheduled slot re-applies its own per-run max, so without this a
 * three-slot day could authorize 3x the intended daily volume.
 *
 * @returns {number} how many submissions this run may still make (>= 0)
 */
function clampToDailyBudget({ perRunMax = 0, dailyCap = 0, submittedToday = 0 } = {}) {
  const remaining = Math.max(0, Math.floor(dailyCap) - Math.max(0, submittedToday));
  if (!perRunMax || perRunMax <= 0) return remaining;
  return Math.min(perRunMax, remaining);
}

module.exports = { getRunExitCode, clampToDailyBudget };
