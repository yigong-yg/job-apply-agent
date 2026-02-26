# Product Requirements Document: Automated Job Application Agent

## Document Metadata

- **Version:** 1.1
- **Date:** 2026-02-24
- **Author:** Yi (via Claude)
- **Status:** Draft — Configuration Finalized, Ready for Testing
- **Scope:** "One-Click Apply" scenarios ONLY across LinkedIn Easy Apply, Indeed Apply, Dice Easy Apply, and Jobright Quick Apply

---

## 1. Executive Summary

### 1.1 Problem Statement

A data scientist job seeker spends 2–4 hours daily on repetitive application submissions across job platforms. The mechanical steps — navigating to listings, clicking apply, confirming pre-filled fields, uploading resumes, and submitting — are identical across hundreds of applications. This is the "head problem": maximizing application volume to increase funnel input.

### 1.2 Solution

Build a Playwright-based automation agent that runs as a daily cron job, automatically applying to all eligible "one-click apply" positions across four platforms. The agent operates exclusively on quick-apply flows where forms are pre-filled from user profiles and require no external redirects, account creation, or multi-page ATS forms.

### 1.3 Explicit Non-Goals

- NO handling of external ATS redirects (Workday, Greenhouse, Lever, etc.)
- NO account registration on any platform
- NO email verification flows
- NO CAPTCHA solving
- NO cover letter customization per application (use platform defaults)
- NO job filtering or quality assessment — apply to ALL eligible positions
- NO resume tailoring per job

---

## 2. Technical Architecture

### 2.1 System Overview

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│  Cron (OS)   │────▶│  Shell Launcher   │────▶│  Node.js Orchestrator│
│  10:00 MST   │     │  run_apply.sh     │     │  index.js            │
└──────────────┘     └──────────────────┘     └──────────┬───────────┘
                                                          │
                     ┌────────────────────────────────────┼────────────────────┐
                     │                                    │                    │
              ┌──────▼───────┐  ┌─────────▼────────┐  ┌──▼──────────┐  ┌─────▼──────┐
              │  LinkedIn    │  │  Indeed           │  │  Dice       │  │  Jobright  │
              │  Module      │  │  Module           │  │  Module     │  │  Module    │
              └──────┬───────┘  └─────────┬────────┘  └──┬──────────┘  └─────┬──────┘
                     │                    │               │                   │
              ┌──────▼────────────────────▼───────────────▼───────────────────▼──────┐
              │                    Playwright Browser Context                        │
              │              (Persistent Profile + Saved Sessions)                   │
              └──────────────────────────────┬──────────────────────────────────────┘
                                             │
              ┌──────────────────────────────▼──────────────────────────────────────┐
              │                        State Manager                                │
              │            (SQLite: applied jobs, run logs, errors)                  │
              └─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Technology Stack

| Component              | Technology                | Rationale                                                    |
| ---------------------- | ------------------------- | ------------------------------------------------------------ |
| Runtime                | Node.js 18+               | Playwright's native runtime; best async support              |
| Browser Automation     | Playwright (chromium)     | Persistent contexts, auto-wait, stealth capabilities         |
| Scheduling             | System cron (Linux/macOS) | Zero dependencies; runs headless                             |
| State Database         | SQLite via `better-sqlite3`| Single-file, no server, fast reads                           |
| Configuration          | JSON file (`config.json`) | Human-readable, easy to edit                                 |
| Logging                | `pino` (JSON logger)      | Structured logs, easy to parse                               |
| Package Manager        | npm                       | Standard Node.js                                             |

### 2.3 Directory Structure

```
job-apply-agent/
├── config.json                 # User profile + search parameters
├── index.js                    # Main orchestrator entry point
├── setup.js                    # One-time session capture (headed browser)
├── benchmark.js                # Benchmark reporting (read-only)
├── run_apply.sh                # Shell launcher for cron
├── .env.example                # Runtime knobs template
├── package.json
├── db/
│   └── applications.db         # SQLite database (auto-created)
├── modules/
│   ├── linkedin.js             # LinkedIn Easy Apply module
│   ├── indeed.js               # Indeed Apply module
│   ├── dice.js                 # Dice Easy Apply module
│   └── jobright.js             # Jobright Quick Apply module
├── lib/
│   ├── browser.js              # Playwright browser manager
│   ├── state.js                # SQLite state manager
│   ├── humanize.js             # Anti-detection utilities
│   ├── form-filler.js          # Generic form field mapping
│   └── logger.js               # Logging setup
├── browser-data/               # Persistent Playwright profile (gitignored)
│   ├── linkedin/
│   ├── indeed/
│   ├── dice/
│   └── jobright/
├── resumes/
│   └── resume.pdf              # Pre-uploaded resume file
└── logs/
    └── YYYY-MM-DD.log          # Daily log files
```

---

## 3. Pre-Conditions & One-Time Setup

### 3.1 User Must Complete Before First Run

The agent CANNOT automate initial platform setup. The user must manually complete these steps ONCE:

#### 3.1.1 LinkedIn

1. Log in to linkedin.com in the Playwright persistent browser context
2. Ensure profile is 100% complete (headline, experience, education, skills)
3. Verify that the "Easy Apply" profile settings are filled:
   - Phone number
   - Email address
   - Current job title
   - Resume uploaded to LinkedIn profile
4. Apply to ONE job manually to confirm Easy Apply flow works and profile data pre-fills correctly
5. Save the browser session state

**How to capture session:**

```bash
node setup.js --platform linkedin
# This launches a visible Chromium window using the persistent context directory
# User logs in manually, completes any 2FA/CAPTCHA
# On successful login, session cookies are saved to browser-data/linkedin/
# User closes browser when done
```

#### 3.1.2 Indeed

1. Log in to indeed.com in the Playwright persistent browser context
2. Complete Indeed Profile:
   - Contact information (name, email, phone)
   - Resume uploaded to Indeed
   - Work experience entries
   - Education entries
3. Navigate to any "Easily apply" job and verify the pre-filled form populates correctly
4. Save session state

**Indeed-specific note:** Indeed uses the badge text "Easily apply" on job cards. The feature is officially called "Indeed Apply." The form fields for Indeed Apply are: first name, last name, email, phone number, city/state, resume (pre-attached from profile). Some employers add screener questions (yes/no or multiple-choice).

#### 3.1.3 Dice

1. Log in to dice.com in the Playwright persistent browser context
2. Complete Dice profile:
   - Contact details
   - Resume uploaded
   - Work authorization status
   - Desired salary (optional but commonly requested)
   - Willing to relocate (yes/no)
3. Verify Easy Apply flow on one job
4. Save session state

**Dice-specific note:** Dice's "Easy Apply" sends the user's profile and resume directly to the employer/recruiter. Some listings include additional screener fields (cover letter text box, work authorization dropdown, security clearance). The form appears as an overlay modal.

#### 3.1.4 Jobright

1. Log in to jobright.ai in the Playwright persistent browser context
2. Upload resume
3. Complete profile preferences (job titles, locations, experience level)
4. Verify the "Auto-Apply" or "Quick Apply" flow on one listing
5. Save session state

**Jobright-specific note:** Jobright has its own Auto-Apply agent feature (paid). This automation targets Jobright's manual apply flow where the user clicks into a job and applies via Jobright's interface, NOT via their AI agent product. The agent effectively replaces the need for Jobright's paid auto-apply tier.

### 3.2 Session Maintenance

Sessions WILL expire. The agent must handle this gracefully:

- **Detection:** Before any apply loop, check login status by navigating to a known authenticated page and checking for login-wall redirects or specific DOM elements (e.g., profile avatar, user name display).
- **On expiration:** Log the failure, skip that platform for the day, and send a notification (stdout log that the user can monitor). Do NOT attempt automated re-login (risk of CAPTCHA, account lock).
- **User action required:** Run `node setup.js --platform <name>` to refresh the session manually.
- **Expected session lifetimes:**
  - LinkedIn: 7–30 days (varies; "Remember me" extends it)
  - Indeed: 14–30 days
  - Dice: 7–14 days
  - Jobright: 7 days (shorter; newer platform)

---

## 4. User Configuration Schema

### 4.1 `config.json` Specification

```json
{
  "user": {
    "firstName": "Yi",
    "lastName": "[LAST_NAME]",
    "email": "[EMAIL]",
    "phone": "[PHONE]",
    "city": "Salt Lake City",
    "state": "UT",
    "country": "US",
    "zipCode": "[ZIP]",
    "linkedinUrl": "https://www.linkedin.com/in/[HANDLE]/",
    "workAuthorization": "Authorized to work in the US",
    "requiresSponsorship": false,
    "willingToRelocate": true,
    "yearsOfExperience": "2",
    "highestEducation": "Master's Degree",
    "veteranStatus": "I am not a protected veteran",
    "disabilityStatus": "I do not wish to answer",
    "gender": "Male",
    "race": "Prefer not to say",
    "desiredSalary": "150000",
    "startDate": "Immediately",
    "resumePath": "./resumes/resume.pdf"
  },

  "search": {
    "keywords": ["data scientist", "machine learning engineer", "data analyst", "ML engineer", "applied scientist", "data engineer"],
    "location": "United States",
    "remoteOnly": false,
    "includeRemote": true,
    "datePosted": "Past week",
    "experienceLevel": ["Entry level", "Associate", "Mid-Senior level"],
    "jobType": ["Full-time"]
  },

  "platforms": {
    "linkedin": {
      "enabled": true,
      "maxApplicationsPerRun": 30
    },
    "indeed": {
      "enabled": true,
      "maxApplicationsPerRun": 30
    },
    "dice": {
      "enabled": true,
      "maxApplicationsPerRun": 30
    },
    "jobright": {
      "enabled": true,
      "maxApplicationsPerRun": 20
    }
  },

  "behavior": {
    "minDelayBetweenActions": 1500,
    "maxDelayBetweenActions": 4000,
    "minDelayBetweenApplications": 5000,
    "maxDelayBetweenApplications": 15000,
    "typingSpeed": { "min": 50, "max": 150 },
    "scrollBehavior": "human",
    "maxRetries": 2,
    "screenshotOnError": true,
    "headless": true
  },

  "notifications": {
    "logToFile": true,
    "logToStdout": true
  }
}
```

> **Note:** No static `searchUrl` fields in platform configs. Each platform module constructs its search URL dynamically from `search.keywords` and `search.location` at runtime.

### 4.2 Default Answer Map

For screener questions that appear on some quick-apply forms, the agent needs a lookup table of common questions and their default answers. This is separate from `config.json` for clarity.

> **Note:** See `defaultAnswers.json` for the complete answer map (~60 entries). The subset below shows the pattern:

```json
{
  "defaultAnswers": {
    "years of experience": "2",
    "years of relevant experience": "2",
    "are you legally authorized to work": "Yes",
    "do you now or will you in the future require sponsorship": "No",
    "are you willing to relocate": "Yes",
    "what is your expected salary": "150000",
    "desired salary": "150000",
    "when can you start": "Immediately",
    "highest level of education": "Master's Degree",
    "do you have experience with python": "Yes",
    "do you have experience with machine learning": "Yes",
    "linkedin profile": "https://www.linkedin.com/in/[HANDLE]/",
    "github": "https://github.com/[GITHUB_HANDLE]",
    "cover letter": "",
    "disability status": "I do not wish to answer"
  }
}
```

---

## 5. Platform-Specific Application Flows

### 5.1 LinkedIn Easy Apply

#### 5.1.1 Feature Identification

- **Badge:** Blue "Easy Apply" button on job cards (as opposed to gray "Apply" which redirects externally)
- **Selector hint:** `button.jobs-apply-button` with inner text containing "Easy Apply", or `[data-control-name="jobdetails_topcard_inapply"]`
- **Location:** Appears in job detail sidebar or top card

#### 5.1.2 Application Flow (Step by Step)

```
1. NAVIGATE to dynamically constructed search URL (geoId=103644278 [United States] + URL-encoded keywords from config.search.keywords + f_AL=true [Easy Apply] + f_TPR=r604800 [Past week])
2. WAIT for job list to load (selector: `.jobs-search-results-list`)
3. FOR EACH job card in the list:
   a. READ job ID from card's data attribute or href
   b. CHECK against SQLite database — if already applied, SKIP
   c. CLICK job card to load detail panel
   d. WAIT for detail panel to load
   e. LOCATE the "Easy Apply" button
      - If button text is "Apply" (not "Easy Apply") → SKIP (external redirect)
      - If button text is "Easy Apply" → CONTINUE
   f. CLICK "Easy Apply" button
   g. WAIT for modal/overlay to appear

4. INSIDE THE EASY APPLY MODAL:
   The modal is multi-step. Each step has a "Next", "Review", or "Submit application" button.

   STEP 1 — Contact Info (usually pre-filled):
   - First Name (input, pre-filled from profile)
   - Last Name (input, pre-filled from profile)
   - Email (input or dropdown if multiple emails)
   - Phone (input, pre-filled)
   - Phone country code (dropdown, usually pre-set)
   - City/Location (input, pre-filled)
   → Fields should already be filled. VERIFY they are non-empty.
   → CLICK "Next"

   STEP 2 — Resume (varies):
   - Option A: "Use last resume" shown with filename → select it
   - Option B: Upload resume → use file chooser to upload from config.resumePath
   - Option C: Resume already attached from profile → no action needed
   → CLICK "Next"

   STEP 3 — Additional Questions (0 or more screens):
   These are employer-specific screener questions. Common types:
   - TEXT INPUT: "Years of experience with [X]" → fill from defaultAnswers
   - DROPDOWN/SELECT: "Highest education level" → select matching option
   - RADIO BUTTONS: "Are you authorized to work?" Yes/No → select Yes
   - CHECKBOX: "I agree to the terms" → check it
   - TEXTAREA: "Cover letter" or "Additional info" → leave empty or fill minimal text

   FOR EACH question field on the current step:
     a. READ the label text (normalize to lowercase, strip punctuation)
     b. MATCH against defaultAnswers keys using fuzzy string matching
     c. IF match found → fill the answer
     d. IF no match found → attempt to fill with a safe default:
        - Text inputs: use "" (empty) or "N/A"
        - Dropdowns: select the first non-placeholder option
        - Radio buttons: select "Yes" if available, else first option
        - Checkboxes: check if label contains "agree" or "certify"
     e. LOG any unmatched fields to unfilled_fields.log for future config improvement
   → CLICK "Next" or "Review"

   STEP 4 — Review:
   - This screen shows a summary. No action needed except clicking submit.
   - OPTIONAL: Check the "Follow [Company]" checkbox — UNCHECK it to avoid noise
   → CLICK "Submit application"

5. POST-SUBMISSION:
   a. WAIT for confirmation message (e.g., "Application submitted" or success modal)
   b. RECORD to SQLite: {platform: "linkedin", jobId, jobTitle, company, timestamp, status: "submitted"}
   c. CLOSE the modal (click X or "Done")
   d. WAIT random delay (5–15 seconds)
   e. CONTINUE to next job card

6. PAGINATION:
   After processing all visible job cards, SCROLL to bottom or CLICK "See more jobs" / next page button.
   REPEAT until maxApplicationsPerRun reached or no more jobs.
```

#### 5.1.3 Known Gotchas

- LinkedIn may show a "Your application was sent previously" message → detect and skip
- Some Easy Apply jobs still have 5+ steps with many screener questions → process all steps
- LinkedIn may trigger "Let us know you're not a robot" CAPTCHA after ~50 rapid applies → rate limit is critical
- "Save" button exists alongside "Submit" — be careful to click the correct one
- The modal can have a "Discard" confirmation if closed without submitting
- LinkedIn uses shadow DOM in some components — may need `page.evaluate()` for certain selectors

### 5.2 Indeed Apply ("Easily Apply")

#### 5.2.1 Feature Identification

- **Badge:** Job cards marked with "Easily apply" text badge
- **Selector hint:** `.easily-apply-badge`, or `span` containing text "Easily apply"
- **Alternative:** Some cards show "Apply now" which is ALSO Indeed Apply (not external)

#### 5.2.2 Application Flow

```
1. NAVIGATE to search URL (pre-configured with Indeed Apply filter)
   Indeed Apply filter parameter: `sc=0kf%3Aattr(DSQF7)%3B` in URL
2. WAIT for job list to load (selector: `#mosaic-provider-jobcards`)
3. FOR EACH job card:
   a. READ job ID from `data-jk` attribute on the card
   b. CHECK against SQLite — if already applied, SKIP
   c. CLICK job card to open detail panel (right side on desktop)
   d. WAIT for detail panel to load
   e. LOCATE "Apply now" or "Easily apply" button in the detail panel
      - If button links to external URL → SKIP
      - If button opens Indeed's own apply overlay → CONTINUE
   f. CLICK the apply button

4. INDEED APPLY FORM:
   Indeed Apply can be single-page or multi-step.

   STEP 1 — Contact & Resume:
   - Name (pre-filled from Indeed profile)
   - Email (pre-filled)
   - Phone (pre-filled, sometimes optional)
   - Resume: Usually pre-attached from Indeed profile. Options:
     - "Indeed Resume" (pre-selected) → leave as-is
     - Upload new → only if no resume is pre-attached
   - City/State (sometimes, pre-filled)
   → VERIFY fields are populated
   → CLICK "Continue" or "Apply"

   STEP 2 — Screener Questions (if employer added them):
   Similar to LinkedIn — employer-defined questions.
   Common Indeed screener question types:
   - "Do you have a valid driver's license?" → Radio: Yes/No
   - "How many years of [skill] experience?" → Text input or dropdown
   - "Are you authorized to work in the US?" → Radio: Yes/No
   - "What is your expected pay?" → Text input
   - Qualification questions with "Required" tag → must answer

   FOR EACH question: same fuzzy-match logic as LinkedIn (Section 5.1.2, Step 3)
   → CLICK "Continue"

   STEP 3 — Review & Submit:
   - Review page shows summary
   - May have a "Write a cover letter (optional)" textarea → leave empty
   → CLICK "Submit your application" or "Apply"

5. POST-SUBMISSION:
   a. Detect confirmation: "Your application has been submitted" or redirect to "applied" page
   b. RECORD to SQLite
   c. Navigate back to job search results
   d. WAIT random delay
   e. CONTINUE to next job card

6. PAGINATION:
   Indeed uses infinite scroll + "Page 2, 3, ..." links at bottom.
   Navigate to next page after processing all visible jobs.
```

#### 5.2.3 Known Gotchas

- Indeed has aggressive bot detection — randomized delays are critical
- Some "Apply now" buttons still redirect to company career sites — detect by checking if URL changes to a non-indeed.com domain after click
- Indeed may require re-entering phone number even if profile has it
- Indeed's mobile-responsive layout changes DOM structure at narrow viewport widths — use a standard desktop viewport (1280x800+)
- "Easily apply" badge sometimes appears on jobs that STILL have employer screener questions requiring detailed free-text responses — these are still in-scope but may fail on unanswerable questions
- Indeed may show a "We noticed you already applied" interstitial → detect and skip

### 5.3 Dice Easy Apply

#### 5.3.1 Feature Identification

- **Badge:** "Easy Apply" button on job detail page
- **Selector hint:** Button with text "Easy Apply" (Dice uses React; elements may have dynamic class names)
- **Distinguisher:** Jobs without Easy Apply show "Apply" which redirects to employer site

#### 5.3.2 Application Flow

```
1. NAVIGATE to Dice search URL
2. WAIT for job cards to load
3. FOR EACH job card:
   a. READ job ID from URL or card attribute
   b. CHECK against SQLite — if already applied, SKIP
   c. CLICK job card to open detail page (Dice opens a new page, not a side panel)
   d. WAIT for page to fully load
   e. LOCATE "Easy Apply" button
      - If only "Apply" (redirects externally) → SKIP, go back to search results
   f. CLICK "Easy Apply"

4. DICE EASY APPLY MODAL:
   Dice's Easy Apply is typically a single-screen modal overlay.

   Fields (most pre-filled from Dice profile):
   - Name (pre-filled)
   - Email (pre-filled)
   - Phone (pre-filled)
   - Resume: Pre-attached from profile, or upload option
   - Cover Letter (optional textarea) → leave empty
   - Work Authorization (dropdown) → select from profile data
   - Additional screener questions (employer-specific, 0–5 questions):
     - "Are you willing to relocate?" → Yes/No
     - "What is your desired salary?" → Text input
     - "Do you have [X] years of [Y] experience?" → Text/dropdown
     - "Do you have a security clearance?" → Yes/No/dropdown

   FOR EACH field: fuzzy-match from defaultAnswers
   → CLICK "Submit" or "Apply"

5. POST-SUBMISSION:
   a. Detect confirmation message in modal or page redirect
   b. RECORD to SQLite
   c. Navigate BACK to search results page (browser.goBack() or re-navigate)
   d. WAIT random delay
   e. CONTINUE to next job card

6. PAGINATION:
   Dice uses page number buttons at the bottom of search results.
   Click "Next" or specific page number after processing current page.
```

#### 5.3.3 Known Gotchas

- Dice is heavily recruiter-focused — many "Easy Apply" jobs go directly to staffing agencies, not employers. This is fine for volume strategy but expect recruiter spam.
- Dice's React SPA can be slow to render — use generous `waitForSelector` timeouts
- Some Dice jobs show "Easy Apply" but the modal fails to load due to employer misconfiguration → timeout after 10 seconds, log as error, skip
- Dice may show a "Complete your profile" interstitial before allowing apply → if this appears, log and skip (user needs to fix profile manually)
- Dice sessions expire more frequently — check login at start of each run

### 5.4 Jobright Quick Apply

#### 5.4.1 Feature Identification

- **Badge:** "Apply" or "Quick Apply" button on Jobright job listings
- **Context:** Jobright aggregates jobs from multiple sources. Their internal apply flow lets users submit through Jobright's interface. Jobs that redirect to external sites are OUT OF SCOPE.
- **Distinguisher:** Check if clicking "Apply" keeps the user on jobright.ai domain

#### 5.4.2 Application Flow

```
1. NAVIGATE to Jobright jobs page (user must be logged in)
2. WAIT for job feed to load
3. FOR EACH job listing:
   a. READ job ID
   b. CHECK against SQLite — if already applied, SKIP
   c. CLICK into job detail
   d. LOCATE "Apply" button
   e. CLICK "Apply"
   f. CHECK: Did it stay on jobright.ai?
      - If redirected to external site → go back, SKIP, log as "external_redirect"
      - If stayed on Jobright → CONTINUE

4. JOBRIGHT APPLY FLOW:
   Jobright's apply flow varies based on what they support:

   Option A — Jobright Quick Apply (internal):
   - Resume is auto-attached from Jobright profile
   - May show job match score
   - Click "Submit Application" or "Apply Now"
   - Minimal or no additional fields

   Option B — Jobright Autofill (Chrome extension):
   - NOT IN SCOPE for this agent (extension-based, not automatable via Playwright)

   FOR fields that appear: same fuzzy-match from defaultAnswers
   → CLICK "Submit"

5. POST-SUBMISSION:
   a. Detect confirmation
   b. RECORD to SQLite
   c. Navigate back to job feed
   d. WAIT random delay
   e. CONTINUE

6. PAGINATION:
   Jobright uses infinite scroll. Scroll down to trigger more job loads.
```

#### 5.4.3 Known Gotchas

- Jobright is a newer platform — their DOM structure may change frequently
- Jobright's "Auto-Apply" paid feature (Jobright Agent) might conflict with manual automation — if the user has Jobright Agent enabled, disable it to avoid double applications
- Jobright's job feed is personalized — the agent sees different jobs based on profile, which is fine
- Jobright may require users to have uploaded a resume before any apply action works
- Jobright sessions expire quickly (~7 days) — may need more frequent manual re-login

---

## 6. Core Library Specifications

### 6.1 Browser Manager (`lib/browser.js`)

```
RESPONSIBILITIES:
- Initialize Playwright with persistent browser context per platform
- Each platform gets its own browser-data subdirectory to isolate cookies/sessions
- Configure browser settings:
  - Viewport: 1280 x 800 (standard desktop)
  - User agent: Real Chrome user agent string (not Playwright default)
  - Locale: en-US
  - Timezone: America/Denver (MST)
  - Geolocation: Salt Lake City coordinates (optional)
- Support headless and headed modes (headed for setup, headless for cron)
- Provide utility: launchForPlatform(platformName) → returns { browser, context, page }
- Provide utility: checkLoginStatus(page, platform) → boolean
- Handle cleanup: close browser contexts after run completes

LOGIN STATUS CHECKS:
- LinkedIn: Navigate to linkedin.com/feed — if redirected to /login, session expired
- Indeed: Navigate to indeed.com/account/view — check for login form
- Dice: Navigate to dice.com/dashboard — check for login redirect
- Jobright: Navigate to jobright.ai/jobs — check for login modal/redirect
```

### 6.2 Humanization Layer (`lib/humanize.js`)

```
RESPONSIBILITIES:
- Random delay between actions: sleep(min, max) → Promise
- Human-like typing: typeWithDelay(page, selector, text, {minDelay, maxDelay})
- Random mouse movement before clicks (optional, adds realism)
- Scroll behavior: scrollLikeHuman(page) — scroll in chunks with pauses
- Random viewport micro-adjustments (±10px on resize)

IMPLEMENTATION NOTES:
- All delays use crypto.randomInt() for better randomness than Math.random()
- Delays follow a normal distribution centered between min and max, not uniform
- Between applications: 5–15 second delays (configurable)
- Between form field interactions: 1.5–4 second delays
- Typing speed: 50–150ms per character with occasional pauses
```

### 6.3 Form Filler (`lib/form-filler.js`)

```
RESPONSIBILITIES:
- Accept a page and a question-answer map
- Scan all visible form fields on the current page/modal
- For each field:
  1. Determine field type (text input, textarea, select dropdown, radio group, checkbox)
  2. Read associated label text (try: <label>, aria-label, placeholder, nearby text)
  3. Normalize label: lowercase, strip punctuation, trim whitespace
  4. Fuzzy match against defaultAnswers keys (use string similarity threshold >= 0.6)
  5. Fill the field with the matched answer
  6. If no match: use safe defaults (see Section 5.1.2, Step 3d)
  7. Log unmatched fields for human review

FIELD FILLING STRATEGIES:
- text/number input: clear existing value, type new value with humanized delay
- textarea: same as text input
- select/dropdown: find option whose text matches answer, select it
- radio buttons: find radio whose label matches answer, click it
- checkbox: check if label contains trigger words ("agree", "certify", "confirm"), then check
- file upload: use page.setInputFiles() with resume path from config
```

### 6.4 State Manager (`lib/state.js`)

```
DATABASE SCHEMA (SQLite):

TABLE applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL,          -- 'linkedin' | 'indeed' | 'dice' | 'jobright'
  jobId         TEXT NOT NULL,          -- Platform-specific job identifier
  jobTitle      TEXT,
  company       TEXT,
  jobUrl        TEXT,
  status        TEXT NOT NULL,          -- 'submitted' | 'skipped' | 'error' | 'already_applied' | 'dry_run' | 'captcha_blocked'
  errorMessage  TEXT,
  skipReason    TEXT,                   -- Why this job was skipped (e.g. 'already_applied_db', 'no_easy_apply_button')
  appliedAt     TEXT NOT NULL,          -- ISO 8601 timestamp
  runId         TEXT NOT NULL           -- UUID for each cron run
);

TABLE runs (
  id            TEXT PRIMARY KEY,       -- UUID
  startedAt     TEXT NOT NULL,
  completedAt   TEXT,
  platformStats TEXT                    -- JSON: {"linkedin": {"applied": 15, "skipped": 3, "errors": 2}}
);

TABLE unfilled_fields (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL,
  jobId         TEXT,
  fieldLabel    TEXT NOT NULL,
  fieldType     TEXT,
  timestamp     TEXT NOT NULL
);

OPERATIONS:
- hasApplied(platform, jobId) → boolean
- recordApplication(platform, jobId, jobTitle, company, jobUrl, status, errorMessage, runId)
- recordUnfilledField(platform, jobId, fieldLabel, fieldType)
- getRunStats(runId) → aggregated counts
- createRun() → runId
- completeRun(runId, stats)
```

---

## 7. Orchestrator Logic (`index.js`)

```
MAIN EXECUTION FLOW:

1. LOAD config.json and defaultAnswers.json
2. CREATE new run record in SQLite → get runId
3. LOG "Starting job application run {runId} at {timestamp}"

4. FOR EACH enabled platform in config.platforms:
   a. LOG "Processing platform: {platformName}"
   b. LAUNCH persistent browser context for platform
   c. CHECK login status
      - If NOT logged in:
        - LOG "Session expired for {platform}. Skipping. Run setup.js to refresh."
        - RECORD platform as skipped in run stats
        - CLOSE browser context
        - CONTINUE to next platform
      - If logged in:
        - LOG "Session valid for {platform}"

   d. NAVIGATE to search URL
   e. SET applicationCount = 0

   f. WHILE applicationCount < maxApplicationsPerRun:
      i.   GET list of job cards on current page
      ii.  FOR EACH job card:
           - EXTRACT jobId, jobTitle, company
           - IF hasApplied(platform, jobId) → SKIP
           - TRY:
             - EXECUTE platform-specific apply flow
             - recordApplication(platform, jobId, ..., "submitted", null, runId)
             - applicationCount++
           - CATCH (error):
             - SCREENSHOT if config.screenshotOnError
             - recordApplication(platform, jobId, ..., "error", error.message, runId)
             - LOG error details
             - CONTINUE to next job (don't crash the run)
           - WAIT humanized delay between applications
           - IF applicationCount >= maxApplicationsPerRun → BREAK
      iii. IF more pages available → NAVIGATE to next page
           ELSE → BREAK

   g. LOG "{platform} complete: {applicationCount} applications submitted"
   h. CLOSE browser context

5. COMPLETE run record with aggregate stats
6. LOG "Run {runId} complete. Total: {stats}"
7. EXIT process
```

---

## 8. Error Handling & Resilience

### 8.1 Error Categories

| Error Type              | Handling Strategy                                          |
| ----------------------- | ---------------------------------------------------------- |
| Session expired         | Skip platform, log warning, continue other platforms       |
| Element not found       | Wait up to 10s, retry once, then skip job and log          |
| Modal failed to open    | Wait 10s timeout, skip job, log error                      |
| CAPTCHA detected        | Stop platform immediately, log critical warning            |
| Network timeout         | Retry current action once, then skip job                   |
| "Already applied" msg   | Record as `already_applied`, skip, continue                |
| External redirect       | Detect domain change, go back, skip job                    |
| Unmatched form field    | Fill with safe default, log to unfilled_fields table       |
| Browser crash           | Catch at orchestrator level, continue to next platform     |
| Unexpected page state   | Take screenshot, log, skip job                             |

### 8.2 CAPTCHA Detection

```
CAPTCHA INDICATORS TO CHECK:
- LinkedIn: Page contains text "Let's do a quick security check" or iframe with captcha
- Indeed: Page contains reCAPTCHA iframe or "unusual activity" text
- Dice: Cloudflare challenge page ("Checking your browser")
- Jobright: Any challenge page

ON CAPTCHA DETECTION:
1. LOG "CAPTCHA detected on {platform}. Stopping platform."
2. RECORD remaining jobs as skipped with reason "captcha_blocked"
3. DO NOT retry — CAPTCHAs indicate the platform has flagged the session
4. User must manually solve CAPTCHA by running setup.js
```

### 8.3 Rate Limiting Strategy

```
PER PLATFORM PER RUN:
- LinkedIn: max 30 applications (LinkedIn is most aggressive about detection)
- Indeed: max 30 applications
- Dice: max 30 applications
- Jobright: max 20 applications

TIMING:
- Between applications: 5–15 seconds (random)
- Between page navigations: 2–5 seconds (random)
- Between form field fills: 1.5–4 seconds (random)
- Total estimated run time per platform: 15–45 minutes
- Total estimated daily run time (all 4): 60–180 minutes
```

---

## 9. Scheduling & Deployment

### 9.1 Cron Setup

```bash
# run_apply.sh
#!/bin/bash
set -e

export PATH="/usr/local/bin:/usr/bin:$PATH"
export DISPLAY=:0  # Only needed if running headed (not for headless)

cd /path/to/job-apply-agent
node index.js 2>&1 | tee -a logs/$(date +%Y-%m-%d).log
```

```bash
# Crontab entry (10:00 AM MST = 17:00 UTC during standard time, 16:00 UTC during DST)
# Use America/Denver timezone in cron if supported, otherwise calculate UTC offset
0 10 * * 1-5 /path/to/job-apply-agent/run_apply.sh
# Runs Monday through Friday only
```

**Windows:** `run_apply.bat` is available for Windows Task Scheduler. It invokes Git Bash with `run_apply.sh`. Schedule it as a daily task at 10:00 AM via Task Scheduler.

### 9.2 System Requirements

- Windows 11, macOS, or Linux (Ubuntu 22+)
- Node.js 18 or higher
- Playwright system dependencies (`npx playwright install-deps`)
- Chromium browser (installed via `npx playwright install chromium`)
- ~500MB disk for browser binary + profiles
- Stable internet connection during run window

### 9.3 Monitoring

The agent produces structured JSON logs via `pino`. Each run generates:

```json
{
  "runId": "uuid-here",
  "timestamp": "2026-02-19T10:00:00-07:00",
  "level": "info",
  "platform": "linkedin",
  "event": "application_submitted",
  "jobId": "12345",
  "jobTitle": "Data Scientist",
  "company": "Acme Corp"
}
```

Key metrics to monitor:
- Applications submitted per platform per day
- Error rate per platform
- Session expiry frequency
- Unmatched form fields (to improve defaultAnswers over time)

---

## 10. Testing Strategy

### 10.1 Development & Testing Phases

**Phase 1: Single Platform, Headed Mode**
- Start with LinkedIn only
- Run in headed mode (visible browser) to observe behavior
- Manually verify each step of the flow
- Use `maxApplicationsPerRun: 3` for testing

**Phase 2: Form Filler Validation**
- Collect screenshots of all unique screener question patterns encountered
- Verify fuzzy matching accuracy
- Add missing questions to defaultAnswers

**Phase 3: Multi-Platform, Headed Mode**
- Enable all 4 platforms
- Run sequentially, observe each
- Fix platform-specific quirks

**Phase 4: Headless Mode Testing**
- Switch to headless
- Run from terminal (not IDE)
- Verify screenshots are captured on errors

**Phase 5: Cron Integration**
- Set up cron for a test time (e.g., 5 minutes from now)
- Verify the script runs to completion
- Check log output
- Confirm SQLite records are created

### 10.2 Dry Run Mode

Add a `--dry-run` flag that:
- Goes through the entire flow EXCEPT clicking the final "Submit" button
- Takes a screenshot of the review/submit screen instead
- Records applications as `status: "dry_run"` in SQLite
- Useful for validating form filling without actually submitting

```bash
node index.js --dry-run
```

---

## 11. Metrics & Reporting

### 11.1 Daily Summary Report

After each run completes, generate a summary log:

```
═══════════════════════════════════════════════
  JOB APPLICATION AGENT — DAILY REPORT
  Run ID: abc-123-def
  Date: 2026-02-19
  Duration: 47 minutes
═══════════════════════════════════════════════
  LinkedIn:  22 applied | 5 skipped (already applied) | 3 errors
  Indeed:    18 applied | 7 skipped | 5 errors
  Dice:      25 applied | 2 skipped | 3 errors
  Jobright:  12 applied | 4 skipped | 4 errors (3 external redirects)
  ─────────────────────────────────────────────
  TOTAL:     77 applied | 18 skipped | 15 errors
  Session Status: LinkedIn ✓ | Indeed ✓ | Dice ✓ | Jobright ✗ (expired)
  Unmatched Fields: 8 new (see unfilled_fields table)
═══════════════════════════════════════════════
```

### 11.2 Weekly Analytics Query

```sql
-- Applications per platform per day, last 7 days
SELECT
  platform,
  DATE(appliedAt) as date,
  COUNT(CASE WHEN status = 'submitted' THEN 1 END) as applied,
  COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
  COUNT(CASE WHEN status = 'skipped' THEN 1 END) as skipped
FROM applications
WHERE appliedAt >= DATE('now', '-7 days')
GROUP BY platform, DATE(appliedAt)
ORDER BY date DESC, platform;
```

---

## 12. Risk Register

| Risk                                      | Likelihood | Impact | Mitigation                                                       |
| ----------------------------------------- | ---------- | ------ | ---------------------------------------------------------------- |
| LinkedIn account restricted/banned        | Medium     | High   | Rate limit to 30/day; randomize delays; use real profile         |
| Indeed blocks automation                  | Medium     | Medium | Randomize; use desktop viewport; don't exceed 30/day             |
| Platform DOM changes break selectors      | High       | Medium | Use semantic selectors (text, role) not CSS classes; log failures|
| Sessions expire faster than expected      | Medium     | Low    | Check login at run start; alert user to refresh                  |
| CAPTCHA triggered                         | Medium     | Medium | Stop immediately; don't retry; user manually resolves            |
| Applying to irrelevant/spam jobs          | High       | Low    | Acceptable per product strategy (volume over precision)          |
| Employer sees duplicate from multiple platforms | Low   | Low    | Different platforms = different application channels; acceptable  |
| Resume not tailored = low conversion      | High       | Medium | Out of scope; this agent solves HEAD problem, not TAIL           |

---

## 13. Future Enhancements (Out of Scope for V1)

- Slack/Discord/email notification on run completion
- Web dashboard for viewing application history
- Resume tailoring per job using LLM (Claude API)
- Smart filtering: skip jobs that are clearly mismatched (e.g., "10+ years required" for 3 YOE)
- Support for semi-automated Greenhouse/Lever apply (Tier 2 from earlier discussion)
- Integration with Jobright's paid Auto-Apply to avoid duplication

---

## 14. Implementation Order

1. **`lib/browser.js`** + **`setup.js`** — Get persistent browser sessions working for all 4 platforms
2. **`lib/state.js`** — SQLite schema and operations
3. **`lib/humanize.js`** — Delay and typing utilities
4. **`lib/form-filler.js`** — Generic form detection and filling
5. **`modules/linkedin.js`** — LinkedIn Easy Apply (most well-documented, start here)
6. **`index.js`** — Orchestrator (test with LinkedIn only first)
7. **`modules/dice.js`** — Dice Easy Apply (simpler single-modal flow)
8. **`modules/indeed.js`** — Indeed Apply
9. **`modules/jobright.js`** — Jobright Quick Apply (least documented, do last)
10. **`run_apply.sh`** + cron setup
11. **`--dry-run` mode**
12. **Testing & tuning** — rate limits, fuzzy matching, error recovery

---

## 15. Backbone Publish Readiness (Engineering Gate)

This section defines a strict quality gate before merging to `main`. Treat each item as required unless explicitly waived.

### 15.1 Repository Integrity Gate

- [ ] Source directories are tracked in git (`lib/`, `modules/`, orchestration scripts).
- [ ] Runtime/state directories are gitignored (`browser-data/`, `db/`, `logs/`, `resumes/`, `screenshots/`).
- [ ] No secrets/PII placeholders accidentally replaced in tracked config defaults.
- [ ] `README.md` startup path is reproducible on a clean clone.
- [ ] Lockfile is committed and consistent with `package.json`.

### 15.2 Functional Gate

- [ ] `node setup.js --platform <name>` works for each enabled platform.
- [ ] `node index.js --dry-run --platform <name>` runs without fatal crash for each platform.
- [ ] `node index.js` completes at least one full platform loop with valid session.
- [ ] Session expiry path is validated (platform skipped, run continues).
- [ ] CAPTCHA/bot challenge detection path is validated (platform abort behavior).

### 15.3 Data/Observability Gate

- [ ] SQLite schema auto-creates on first run.
- [ ] `applications`, `runs`, `unfilled_fields` tables receive records correctly.
- [ ] End-of-run summary prints and aligns with DB counts.
- [ ] Error screenshots are captured when `screenshotOnError=true`.
- [ ] Daily log file writes to `logs/YYYY-MM-DD.log`.

### 15.4 Operational Gate

- [ ] Windows launcher (`run_apply.bat`) tested under Task Scheduler.
- [ ] Bash launcher (`run_apply.sh`) tested from shell.
- [ ] Failure does not leave orphan browser process for common error paths.
- [ ] Max applications per platform behaves as configured.
- [ ] `--platform` filter executes only requested platform.

### 15.5 Product Alignment Gate

- [ ] Only one-click apply flows are automated.
- [ ] External ATS redirects are skipped and logged.
- [ ] Unmatched fields are logged for future answer-map hardening.
- [ ] No auto-relogin or CAPTCHA solving behavior exists.
- [ ] Throughput strategy (volume-first) remains explicit in docs and behavior.

---

## 16. Technical Walkthrough (As-Implemented Backbone)

This section is a practical map from runtime entrypoint to platform execution, intended for implementation/review handoff.

### 16.1 Boot Sequence

1. `index.js` loads `config.json` and `defaultAnswers.json`.
2. Required runtime directories are created if absent.
3. Run record is created in SQLite (`runs` table) with UUID.
4. Platform list is derived from `config.platforms.*.enabled`, optionally filtered by `--platform`.

### 16.2 Platform Execution Contract

For each platform (`linkedin`, `indeed`, `dice`, `jobright`):

1. Launch persistent Playwright context using `lib/browser.js`.
2. Validate login status against platform-specific authenticated page.
3. If session expired: mark platform skipped and continue (non-fatal).
4. Execute platform module apply loop:
   - discover jobs
   - dedupe by `state.hasApplied()`
   - attempt apply flow
   - record status (`submitted`, `dry_run`, `skipped`, `already_applied`, `error`)
5. Close context in `finally` block.

### 16.3 Form Handling Contract

`lib/form-filler.js` responsibilities:

- Find visible inputs/selects/radios/checkboxes/files.
- Extract labels via `for/id`, ARIA, placeholder, name, nearby context.
- Normalize + fuzzy-match against `defaultAnswers`.
- Fill known values, apply safe defaults where suitable.
- Return unmatched fields for storage in `unfilled_fields`.

### 16.4 State Contract

`lib/state.js` responsibilities:

- Own DB initialization and schema creation.
- Expose idempotent checks (`hasApplied`) and write methods.
- Persist per-job outcome with run linkage.
- Persist run lifecycle and aggregate metadata.

### 16.5 Operational Behaviors

- Humanized waits are centralized in `lib/humanize.js`.
- Dry run mode suppresses final submit and records `dry_run`.
- Screenshot capture is best-effort and non-blocking.
- Platform-level errors are isolated so one platform failure does not abort the run.

### 16.6 Known Backbone Risks to Track

- Dynamic platform DOM changes can invalidate selectors quickly.
- Fuzzy answer matching threshold may produce false positives on ambiguous labels.
- Current DB uniqueness strategy prioritizes latest job state over historical attempts for same `(platform, jobId)`.
- Scheduler environments (PATH/Python/Playwright binary resolution) can diverge from interactive shell.

*End of PRD*