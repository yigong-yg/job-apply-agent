# Job Apply Agent — Runtime Spec & Findings

Living document. Updated by Claude Code as we learn things from production runs.

---

## LinkedIn Rate Limits (tested 2026-03-12, updated 2026-03-17)

- **Daily Easy Apply limit: ~35 applications per session**
- LinkedIn has two rate limit mechanisms:
  1. **Button disabled:** Easy Apply button becomes greyed out (`element is not enabled`). Silent — no message shown.
  2. **Explicit modal message:** "We limit daily submissions to maintain quality and prevent bots, helping each application get the right attention. Save this job and apply tomorrow." — shown in a modal after clicking Easy Apply.
- The agent detects both: button-disabled causes timeout errors (existing retry logic), the modal message triggers immediate clean shutdown with `daily_limit_reached` skip reason.
- Error signature (button disabled): `elementHandle.click: Timeout 30000ms exceeded` + `element is not enabled` in Playwright call log.
- The limit appears to be per-calendar-day (UTC or account timezone TBD).
- The limit is NOT per-search — it persists across page navigation within the same session.
- `maxApplicationsPerRun: 30` is safely under the limit. Could push to 33 but buffer is wise.

### Run stats from limit test (run 3cf7983c, 2026-03-12)
- 35 submitted, 11 errors (all rate-limited), 9 skipped (no Easy Apply), 2 already_applied
- Run duration: ~31 minutes for 35 submissions (~53s avg per app including delays)
- Rate limiting kicked in on page 3 after 35 successful submissions
- No CAPTCHA triggered, no account restriction observed post-run

### Throughput
- Average time per application: ~53 seconds (includes 5-15s inter-app delay + form filling + modal steps)
- Best observed: 36s avg (2026-03-17 run with location filters, 20 apps in 14 min)
- Applications with 1 step (pre-filled, no questions): ~15s active time
- Applications with 5+ steps: ~25-30s active time
- NielsenIQ job had 8 steps (max observed)

### LLM fallback usage
- Triggered for: "Please list legal first and last name", "Retrieval-Augmented Generation (RAG)"
- LLM tier 3 (short mode) answered both correctly
- No LLM failures observed in this run

---

## Platform Limit Summary

| Platform  | Daily Limit | Limit Type | Config Setting | Notes |
|-----------|-------------|------------|----------------|-------|
| LinkedIn  | ~35         | Button disabled + modal message | 30 | Tested 2026-03-12, 2026-03-17 |
| Indeed    | TBD         | TBD        | 30 | Not yet tested at scale |
| Dice      | TBD         | TBD        | 30 | Not yet tested at scale |
| Jobright  | TBD         | TBD        | 20 | Not yet tested at scale |

---

## Historical Run Summary (as of 2026-03-17)

### All-time LinkedIn stats: 121 submitted, 22 errors, 39 skipped, 31 already_applied, 8 dry_run

| Date | Submitted | Errors | Skipped | Success Rate | Notes |
|------|-----------|--------|---------|-------------|-------|
| 2026-02-25 | 10 | 1 | 1 | 77% | Early testing |
| 2026-03-01 | 17 | 6 | 5 | 35% | High error rate — validation failures |
| 2026-03-02 | 35 | 4 | 10 | 65% | Good run |
| 2026-03-12 | 35 | 11 | 9 | 61% | Hit rate limit at 35 |
| 2026-03-15 | 4 | 0 | 1 | 100% | Tight filters (salary+exp+location), only 12 cards |
| 2026-03-17 | 20 | 0 | 5 | 100% | Location filters via All Filters, 36s avg/app |

---

## Job Card Filtering

### Promoted jobs (added 2026-03-17)
- Jobs with "Promoted" badge in card text are skipped — typically low-relevance paid placements
- Recorded as `skipped` with `skipReason: 'promoted'`

---

## Known Error Patterns

### 1. Easy Apply button not enabled (LinkedIn rate limit)
- **Cause:** Daily application limit reached
- **Detection:** Consecutive `element is not enabled` timeouts on Easy Apply button click
- **Current behavior:** Retries 3x (wastes ~90s per job), records as `error`
- **TODO:** Detect 3+ consecutive button-disabled errors and abort the platform early

### 2. Daily limit modal message (LinkedIn rate limit)
- **Cause:** Daily application limit reached
- **Detection:** Page body contains "We limit daily submissions" or "Save this job and apply tomorrow"
- **Current behavior:** Immediate clean shutdown — dismisses modal, records `daily_limit_reached`, returns stats

### 3. Transient button click timeout (one-off)
- **Cause:** Occasional LinkedIn UI lag, modal not ready
- **Detection:** Single timeout followed by successful retry
- **Current behavior:** Retry logic handles this correctly

### 4. Validation errors on screener steps
- **Cause:** Required fields that fuzzy matching + LLM couldn't fill
- **Detection:** `Validation errors on step N — retry failed`
- **Frequency:** ~7 out of 22 errors (32%)
- **Fix path:** Improve defaultAnswers.json coverage

---

## Search Filter Configuration (as of 2026-03-17)

### LinkedIn search URL parameters
- `geoId=103644278` — United States
- `f_AL=true` — Easy Apply only
- `f_TPR=r86400` — Past 24 hours
- `f_E=2,3,4` — Entry level + Associate + Mid-Senior level
- `f_SB2=5` — Salary $120k+

### Location filter (server-side via "All filters" dialog)
- **Mechanism:** Open LinkedIn's "All filters" dialog -> check location checkboxes -> click "Show results"
- **Cities configured:** New York NY, Boston MA, San Francisco CA, Los Angeles CA, San Jose CA, San Diego CA, Palo Alto CA, Santa Clara CA, Sunnyvale CA, Mountain View CA, Irvine CA
- **Behavior:** Only cities that appear in LinkedIn's pre-populated checkbox list are checked; others silently skipped

### Filter impact on volume
- With all filters (salary $120k+ / exp level / location / past 24h / Easy Apply): ~20 cards per search
- Without salary filter: ~60+ cards
- Without location filter: ~136 cards

---

## Config Decisions & Rationale

- `datePosted: "Past week"` in config but `buildSearchUrl()` uses `f_TPR=r86400` (past 24h).
- `headless: true` in config but overridden by `.env HEADLESS=false` for debugging.
- Delays (5-15s between apps, 1.5-4s between actions) — no bot detection triggered in 35 applications.
- `experienceLevel: ["Entry level", "Associate", "Mid-Senior level"]` — maps to `f_E=2,3,4`.
- `minSalary: 120000` — maps to `f_SB2=5` ($120k+ band).
- `locationFilter` — array of "City, ST" strings; matched against LinkedIn's "All filters" location checkboxes.

---

## Notification System Design

### Recommended: Discord Webhook
- Zero auth complexity — just a webhook URL
- Rich embed support (color-coded success/failure)
- Free, no rate limits at our volume
- No npm dependencies needed — native `fetch()` in Node 18+

### Alternative options
- **Telegram Bot:** Simple HTTP API via @BotFather
- **WeChat (PushPlus/Server酱):** More setup friction
- **Email (nodemailer):** May land in spam
- **WhatsApp (Twilio):** Costs money, not recommended
