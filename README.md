# Job Apply Agent

Playwright-based automation for high-volume "one-click apply" flows on LinkedIn, Indeed, Dice, and Jobright.

The project is intentionally optimized for **operator throughput**:
- Apply to all eligible quick-apply jobs.
- Skip external ATS redirects.
- Persist session state per platform.
- Track outcomes in SQLite and structured logs.

## Scope and Constraints

- In scope: LinkedIn Easy Apply, Indeed Apply/Easily Apply, Dice Easy Apply, Jobright internal Quick Apply.
- Out of scope: external ATS forms, account creation, CAPTCHA solving, tailored cover letters.
- Safety behavior: if a platform session is expired or challenge/bot-check is detected, that platform is skipped.

## System Requirements

- Node.js `>=18`
- npm
- Playwright Chromium (`npx playwright install chromium`)
- Windows users: Git for Windows (for `run_apply.bat`)
- Python toolchain only if your environment needs it for `better-sqlite3` compilation

## Quick Start (End-to-End)

### 1) Clone and install dependencies

```bash
npm install
npx playwright install chromium
```

If `better-sqlite3` build fails on Windows, set Python explicitly for install:

```bash
set PYTHON=C:\path\to\python.exe && npm install
```

### 2) Configure profile and defaults

- Edit `config.json`.
- Replace all placeholder values like `[LAST_NAME]`, `[EMAIL]`, `[PHONE]`, `[HANDLE]`.
- Verify `platforms.<name>.enabled`, `maxApplicationsPerRun`, and `searchUrl`.
- Edit `defaultAnswers.json` to align with your profile answers.

### 3) Place resume file

- Put resume at `resumes/resume.pdf` (or update `config.json > user.resumePath`).

### 4) Capture sessions (required, one-time per platform)

Run setup for each platform you plan to use:

```bash
node setup.js --platform linkedin
node setup.js --platform indeed
node setup.js --platform dice
node setup.js --platform jobright
```

Or run all sequentially:

```bash
node setup.js --platform all
```

When browser opens: complete login + 2FA manually, confirm profile prefill quality, then close browser.
Sessions are persisted under `browser-data/<platform>/`.

### 5) Validate with dry run first

```bash
node index.js --dry-run
```

Recommended pre-production trial sequence:
- `node index.js --dry-run --platform linkedin`
- `node index.js --dry-run --platform indeed`
- `node index.js --dry-run --platform dice`
- `node index.js --dry-run --platform jobright`

### 6) Execute production run

```bash
node index.js
```

## Runtime Commands

- Full run: `node index.js`
- Dry run: `node index.js --dry-run`
- Single platform: `node index.js --platform linkedin`
- Single platform dry run: `node index.js --dry-run --platform dice`

## Scheduling

### Windows Task Scheduler

1. Open Task Scheduler (`taskschd.msc`)
2. Create task `Job Apply Agent`
3. Trigger: weekdays at desired time
4. Action: start program `C:\path\to\job-apply-agent\run_apply.bat`
5. Enable "Run whether user is logged on or not"
6. Enable "Run with highest privileges"

### Linux/macOS Cron

Use `run_apply.sh` directly:

```bash
0 10 * * 1-5 /path/to/job-apply-agent/run_apply.sh >> /path/to/job-apply-agent/logs/cron.log 2>&1
```

## Observability and Data

- Logs: `logs/YYYY-MM-DD.log`
- Error screenshots: `logs/errors/`
- SQLite DB: `db/applications.db`
- End-of-run report: printed to stdout

Useful SQL checks:

```sql
SELECT platform, status, COUNT(*) AS n
FROM applications
WHERE date(appliedAt) = date('now')
GROUP BY platform, status;
```

```sql
SELECT platform, DATE(appliedAt) AS date,
  COUNT(CASE WHEN status='submitted' THEN 1 END) AS applied,
  COUNT(CASE WHEN status='error' THEN 1 END) AS errors
FROM applications
WHERE appliedAt >= DATE('now', '-7 days')
GROUP BY platform, DATE(appliedAt)
ORDER BY date DESC, platform;
```

## Publish-to-Main Checklist

- `lib/`, `modules/`, `index.js`, `setup.js`, launch scripts present and tracked.
- No personal values committed in `config.json` / `defaultAnswers.json`.
- `README.md` instructions validated on clean clone.
- Dry run passes on at least one platform.
- Session setup documented for all enabled platforms.
- `.gitignore` excludes runtime artifacts (`browser-data/`, `logs/`, `db/`, `resumes/`).

## Repository Layout

```text
job-apply-agent/
├── index.js
├── setup.js
├── config.json
├── defaultAnswers.json
├── run_apply.sh
├── run_apply.bat
├── lib/
├── modules/
├── browser-data/   # gitignored runtime data
├── logs/           # gitignored runtime data
├── db/             # gitignored runtime data
└── resumes/        # gitignored runtime data
```
