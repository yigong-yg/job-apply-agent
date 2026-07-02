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
- **Python** (for native module compilation only): `C:\Users\gongy\anaconda3\python.exe` (3.11.7)
- **npm install requires:** `PYTHON="/c/Users/gongy/anaconda3/python.exe" npm install`
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

## LinkedIn-Specific Knowledge

### Search URL (`buildLinkedInSearchUrl()` in `modules/linkedin.js`)
- Path: `/jobs/search-results/` (not the old `/jobs/search/`)
- `f_AL=true` = Easy Apply, `f_TPR=r86400` = Past 24h (hardcoded)
- `geoId`, `distance`, `f_SAL` = LinkedIn-specific params from `platforms.linkedin` in config
- Keywords from `config.search.keywords`, space-joined (not OR-joined)
- Location filtering is via `geoId` + `distance` in the URL — there is no runtime "All filters" dialog interaction

### DOM Architecture (verified 2026-04-10)
- **Job cards + detail panel:** top-level page, NOT inside any iframe
- **Cards:** `<div role="button">` elements found via `page.getByRole('button').filter({hasText: 'Easy Apply'})`
- **Easy Apply entry:** `<a aria-label="Easy Apply to this job">` in the detail panel, clicked to open the form
- **Apply form:** renders inside `#interop-outlet` → `shadowRoot` (shadow DOM). Standard `page.$()` and `fillForm()` cannot see into it — must use `page.evaluate()` to access the shadow root directly
- **`interop-outlet` overlay:** intercepts pointer events on ALL elements. All clicks must use `el.evaluate(e => e.click())` (JS click) or `{ force: true }`, not regular Playwright `.click()`
- **Promoted detection:** "Promoted by hirer" text in the detail panel (not in card text)

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
