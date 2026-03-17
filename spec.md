# Job Apply Agent — Runtime Spec & Findings

Living document. Updated by Claude Code as we learn things from production runs.

---

## LinkedIn Rate Limits (tested 2026-03-12)

- **Daily Easy Apply limit: ~35 applications per session**
- After hitting the limit, LinkedIn **disables the Easy Apply button** (greyed out, `element is not enabled`). No CAPTCHA, no security challenge, no account warning.
- Error signature: `elementHandle.click: Timeout 30000ms exceeded` + `element is not enabled` in Playwright call log.
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
| LinkedIn  | ~35         | Button disabled | 30 | Tested 2026-03-12 |
| Indeed    | TBD         | TBD        | 30 | Not yet tested at scale |
| Dice      | TBD         | TBD        | 30 | Not yet tested at scale |
| Jobright  | TBD         | TBD        | 20 | Not yet tested at scale |

---

## Historical Run Summary (as of 2026-03-15)

### All-time LinkedIn stats: 101 submitted, 22 errors, 34 skipped, 25 already_applied, 5 dry_run

| Date | Submitted | Errors | Skipped | Success Rate | Notes |
|------|-----------|--------|---------|-------------|-------|
| 2026-02-25 | 10 | 1 | 1 | 77% | Early testing |
| 2026-03-01 | 17 | 6 | 5 | 35% | High error rate — validation failures |
| 2026-03-02 | 35 | 4 | 10 | 65% | Good run |
| 2026-03-12 | 35 | 11 | 9 | 61% | Hit rate limit at 35 |
| 2026-03-15 | 4 | 0 | 1 | 100% | Tight filters (salary+exp+location), only 12 cards |

### Error breakdown (22 total)
- 12x click timeout (rate limit — button disabled)
- 7x validation failure (unfilled required fields on screener step)
- 1x JS error (CSS not defined)
- 2x other timeouts

### Top unfilled form fields (62 total logged)
- 6x "Location (city)" — should map to config.user.city
- 6x "Are you comfortable commuting to this job's location?" — should default Yes
- 5x "Are you a protected veteran?" — should map to config.user.veteranStatus
- 4x "City" — variant of location field
- 3x various certification questions

---

## Known Error Patterns

### 1. Easy Apply button not enabled (LinkedIn rate limit)
- **Cause:** Daily application limit reached
- **Detection:** Consecutive `element is not enabled` timeouts on Easy Apply button click
- **Current behavior:** Retries 3x (wastes ~90s per job), records as `error`
- **TODO:** Detect 3+ consecutive button-disabled errors and abort the platform early instead of grinding through remaining cards

### 2. Transient button click timeout (one-off)
- **Cause:** Occasional LinkedIn UI lag, modal not ready
- **Detection:** Single timeout followed by successful retry
- **Current behavior:** Retry logic handles this correctly

### 3. Validation errors on screener steps
- **Cause:** Required fields that fuzzy matching + LLM couldn't fill
- **Detection:** `Validation errors on step N — retry failed`
- **Frequency:** ~7 out of 22 errors (32%)
- **Fix path:** Improve defaultAnswers.json coverage and fuzzy matching for location/city/veteran fields

---

## Search Filter Configuration (as of 2026-03-17)

### LinkedIn search URL parameters
- `geoId=103644278` — United States
- `f_AL=true` — Easy Apply only
- `f_TPR=r86400` — Past 24 hours
- `f_E=2,3,4` — Entry level + Associate + Mid-Senior level
- `f_SB2=5` — Salary $120k+

### Location filter (server-side via "All filters" dialog)
- **Mechanism:** Open LinkedIn's "All filters" dialog → check location checkboxes → click "Show results"
- **Cities configured:** New York NY, Boston MA, San Francisco CA, Los Angeles CA, San Jose CA, San Diego CA, Palo Alto CA, Santa Clara CA, Sunnyvale CA, Mountain View CA, Irvine CA
- **Behavior:** Only cities that appear in LinkedIn's pre-populated checkbox list are checked; others silently skipped
- **Remote jobs:** Passed through by LinkedIn's own filter logic (not client-side)

#### Location filter implementation history
1. **v1 (2026-03-15):** Client-side filter matching state abbreviations (", CA") — failed because LinkedIn uses metro area names without abbreviations
2. **v2 (2026-03-15):** Added keyword matching for metro area names (e.g. "San Francisco" → CA) — worked but fragile; also skipped jobs with unknown location
3. **v3 (2026-03-17):** Switched to server-side filtering via "All filters" dialog checkboxes — reliable, uses LinkedIn's own UI, no client-side filtering needed

### Filter impact on volume
- With all filters (salary $120k+ / exp level / location / past 24h / Easy Apply): ~20 cards per search
- Without salary filter: ~60+ cards
- Without location filter: ~136 cards

---

## Config Decisions & Rationale

- `datePosted: "Past week"` in config but `buildSearchUrl()` uses `f_TPR=r86400` (past 24h) — avoids re-processing week-old listings already applied to in prior runs.
- `headless: true` in config but overridden by `.env HEADLESS=false` for debugging. Production should use headless.
- Delays (5-15s between apps, 1.5-4s between actions) — no bot detection triggered in 35 applications.
- `experienceLevel: ["Entry level", "Associate", "Mid-Senior level"]` — maps to `f_E=2,3,4`.
- `minSalary: 120000` — maps to `f_SB2=5` ($120k+ band).
- `locationFilter` — array of "City, ST" strings; matched against LinkedIn's "All filters" location checkboxes.
- `config.json searchUrl` field is vestigial — `buildSearchUrl()` constructs the URL dynamically from `config.search.*` fields.

---

## Notification System Design

### Recommended: Discord Webhook

**Why Discord:**
- Zero auth complexity — just a webhook URL
- Rich embed support (color-coded success/failure, fields, timestamps)
- Free, no rate limits at our volume (~1 message/day)
- No npm dependencies needed — native `fetch()` in Node 18+
- Mobile push notifications built in

### Implementation plan

1. Create `lib/notify.js` with `sendRunNotification(stats)` function
2. Add `DISCORD_WEBHOOK_URL` to `.env`
3. Call from `index.js` after run summary is computed
4. Payload: Discord embed with run summary fields

### Embed format
```
[Green/Red bar based on error rate]
Job Application Agent — Daily Report
Date: 2026-03-15 | Duration: 3 min

LinkedIn:  4 applied | 1 skipped | 0 errors
TOTAL:     4 applied | 1 skipped | 0 errors

Session Status: linkedin OK
Unmatched Fields: 3 new
Success Rate: 100%
```

### Alternative options (if Discord not preferred)
- **Telegram Bot:** Create via @BotFather, POST to `/sendMessage` API. Similar simplicity.
- **WeChat (PushPlus/Server酱):** Register for token, POST to API → pushes to WeChat. More setup friction.
- **Email (nodemailer):** SMTP credentials needed, may land in spam. Least real-time.
- **WhatsApp (Twilio):** Costs money, complex approval process. Not recommended.

### Future: Error alerting
- If 3+ consecutive button-disabled errors detected mid-run → send immediate "rate limit hit" notification
- If session expires → send "session expired, run setup.js" notification
- If CAPTCHA detected → send critical alert
