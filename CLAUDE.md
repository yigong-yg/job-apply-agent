# AGENT OPERATING GUIDE

Mandatory context for any agent working on this project. Full PRD archived at `.docs/prd.md` (gitignored).

## Critical Rules

1. **NEVER push `.claude/` to any remote branch.** It is gitignored. If you see it tracked, remove it.
2. **NEVER commit PII** (names, emails, phone numbers, API keys, Discord webhook URLs, Discord user IDs). All PII lives in gitignored runtime files: `config.json`, `defaultAnswers.json`, `.env`.
3. **Always dry-run before prod.** Use `node index.js --dry-run --platform linkedin --max 3` to validate changes.
4. **Do not install Python packages or modify the Python/Anaconda environment.** Node.js only. Python is only needed for compiling `better-sqlite3`.

## Branch Strategy

- **`main`** — Clean, public-facing code. No PII, no `.claude/`. Push here only after review.
- **`local-test`** — Working branch for development. Tracks `main` but has local runtime files (`config.json`, `.env`, etc.) that are gitignored.
- Always work on `local-test`. Merge to `main` only for meaningful commits.
- **Prefer small, modularized commits.** One logical change per commit; don't bundle unrelated edits.
- After merging to `main`, sync `local-test`: `git checkout local-test && git reset --hard origin/main`
- Runtime files (`config.json`, `defaultAnswers.json`, `.env`) must be manually restored after reset since they're gitignored.

## Environment

- **Runtime:** Node.js 22.18.0 on Windows 11
- **Python** (for native module compilation only): `%USERPROFILE%\anaconda3\python.exe` (3.11.7)
- **npm install requires:** `PYTHON="$HOME/anaconda3/python.exe" npm install`
- **Playwright Chromium:** `%LOCALAPPDATA%\ms-playwright\`
- **Browser profiles:** `browser-data/<platform>/` (persistent login sessions, gitignored)

## PII Locations (gitignored, NEVER commit)

| File | Contains |
|------|----------|
| `config.json` | User profile (name, email, phone, zip), search parameters, platform settings |
| `defaultAnswers.json` | Screener question answers (LinkedIn URL, city, salary, etc.) |
| `.env` | API keys (DeepSeek), runtime overrides (MAX_APPLICATIONS, HEADLESS, etc.) |
| `browser-data/` | Saved login sessions per platform |
| `db/applications.db` | Application history with job titles, companies, timestamps |

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main orchestrator — load config, loop platforms, generate report |
| `modules/linkedin.js` | LinkedIn Easy Apply automation (only active platform) |
| `lib/browser.js` | Playwright persistent context launcher |
| `lib/form-filler.js` | Generic form detection + fuzzy matching + LLM fallback |
| `lib/state.js` | SQLite state manager (applications, runs, unfilled_fields) |
| `lib/humanize.js` | Anti-detection delays and human-like typing |
| `lib/llm.js` | DeepSeek LLM integration for unknown form fields |
| `.docs/spec.md` | Technical spec, notification design, DOM reference (gitignored, living doc) |
| `.docs/versions.md` | Version history, concluded findings, historical run log (gitignored) |
| `.docs/decisions.md` | Design decisions log (gitignored) |
| `.docs/prd.md` | Original PRD archive (gitignored) |

## Testing Commands

```bash
node setup.js --platform linkedin    # One-time: capture login session (headed browser)
node index.js --dry-run --platform linkedin --max 3   # Validate without submitting
node index.js --platform linkedin    # Production run (uses .env MAX_APPLICATIONS)
node index.js                        # Full run, all enabled platforms
```

## Scheduling & Budgets

- `run_apply.ps1` runs one slot per Denver day each: morning (<12h), midday (<18h), evening.
  Triggers opt into slots with `-Slots morning` etc.; the default is evening-only so the
  legacy daily-18:00 and user-logon triggers cannot start daytime production runs.
- `DAILY_MAX_APPLICATIONS` (env, default 30) is a cumulative Denver-day submission ceiling:
  every production run subtracts today's submitted count before applying its per-run max.
- Dry runs are recorded with `runs.mode = 'dry_run'`; their rows never feed production
  failure cooldowns or company caps.

## LinkedIn-Specific Knowledge

### Search URL (`buildLinkedInSearchUrl()` in `modules/linkedin.js`)
- Path: `/jobs/search-results/` (not the old `/jobs/search/`)
- `f_AL=true` = Easy Apply, `f_TPR=r86400` = Past 24h (hardcoded)
- `geoId`, `distance`, `f_SAL` = LinkedIn-specific params from `platforms.linkedin` in config
- Keywords from `config.search.keywords`, space-joined (not OR-joined)
- Location filtering is via `geoId` + `distance` in the URL — there is no runtime "All filters" dialog interaction

### DOM Architecture (verified 2026-08-21, re-verified 2026-08-28; redesign landed ~2026-08-13)
- **Job cards + detail panel:** top-level page, NOT inside any iframe
- **Cards:** `<div role="button">` elements found via `page.getByRole('button').filter({hasText: 'Easy Apply'})`
- **Easy Apply entry:** `<button aria-label="Easy Apply to this job">Easy Apply</button>` in the detail panel (was an `<a>` with an `/apply/` href pre-08-13 — anchor-only matching caused 9 days of `no_easy_apply_button` on every job). External jobs render `<button aria-label="Apply on company website">` and must not match.
- **Apply form:** renders in a page-level native `<dialog>` ("N/M pages" step indicator) — NO LONGER in the `#interop-outlet` shadow root (which now holds only styles). `fillShadowForm` is a no-op on this UI; page-level `fillForm` + `fillDialogRadioGroups` do the work.
- **Form action buttons:** `<button>` with text only ("Next", "Review", "Submit application") and NO aria-label. The results pagination also has a "Next" button — action-button locators must be scoped to `dialog`.
- **Screener radios:** `<p>question</p>` followed by `<fieldset role="radiogroup">` of `div[role="radio"]` (aria-label = option, aria-checked = state). The native `input[type=radio]` inside is INVISIBLE — visibility-filtered fill code never sees it; click the `div[role="radio"]`.
- **Text inputs:** interact via the ELEMENT HANDLE (`handle.fill()`/`handle.type()`), never a re-resolved `#id`/`[name=]` selector — the dialog UI reuses ids/names on hidden template nodes and typing lands elsewhere.
- **Overlay:** pointer events are still intercepted. All clicks must use `el.evaluate(e => e.click())` (JS click) or `{ force: true }`, not regular Playwright `.click()`
- **Promoted detection:** "Promoted by hirer" text in the detail panel (not in card text)
- **Post-submit confirmation:** the dialog CLOSES on submit and the detail panel renders plain text "Application status / Application submitted" — NOT a modal, NOT a live region, and often 2-3s after 10s have passed. `waitForSubmissionConfirmation` accepts it only when the URL still identifies the submitted job and the status is new vs the pre-click baseline (20s wait). 13 real submissions on 2026-08-25..29 were logged as "Validation errors" before this evidence existed.
- **Result-list carousel:** LinkedIn re-serves the same promoted card block at the top after every reload, and the scan loop restarts at index 0 after its every-5-clicked-cards reload. The within-run seen-sets (`seenRunCardKeys`/`seenRunJobIds` in `applyLinkedIn`) are what prevent an infinite reload livelock — do not remove them. Pre-fix, runs spent ~2h re-recording the same 5 cards (2,277 duplicate skip rows on 2026-08-28, applied:0).

### Rate Limits
- Daily Easy Apply limit: ~35 applications
- Detection: exact-match on the message "We limit daily submissions to maintain quality and prevent bots, helping each application get the right attention. Save this job and apply tomorrow."
- Agent checks both page text and shadow DOM text for this message, stops cleanly on match

### CAPTCHA Handling
- **TODO:** The current `isCaptchaPage()` checks for old UI selectors (`.jobs-search-results-list`, `.global-nav`) that may not exist in the new `/jobs/search-results/` UI. This needs verification and updating if CAPTCHA detection is still required.

## Common Pitfalls

1. **Orphaned browser processes.** If the agent crashes, Chromium processes may persist and lock `browser-data/linkedin/`. Fix: `taskkill //F //IM chrome.exe` or find PIDs with `wmic process where "name='chrome.exe'" get ProcessId,CommandLine | grep browser-data`
2. **Playwright MCP plugin conflicts.** The MCP Playwright plugin can hold a browser instance on the `browser-data/linkedin/` profile, blocking the agent from launching. Close it before running.
3. **Stale snapshots.** LinkedIn changes DOM frequently. If selectors break, use Playwright MCP plugin to inspect the live page. Save snapshots to `.playwright-mcp/` (gitignored).
4. **Config lost after `git reset --hard`.** Runtime files are gitignored. After any hard reset, restore `config.json`, `defaultAnswers.json`, and `.env` manually.
