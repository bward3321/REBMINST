# REBMINST — REBM Instantly Capacity Monitor

A lightweight automation that monitors the REBM Instantly workspace daily sending capacity, logs results to a Google Sheet, and emails alerts so the team always knows whether we're at, above, or below capacity.

## What It Does

Three times a day, it:
1. Pulls every email account in the REBM Instantly workspace and sums their daily sending limits
2. Pulls today's actual sent volume from Instantly's analytics endpoint
3. Calculates utilization % and assigns a status (🟢 green / 🟡 yellow / 🔴 red / ⚠️ over)
4. Appends the results to a Google Sheet for historical tracking
5. Sends a formatted email alert with a clear "what to do" callout

## Schedule (EDT)

| Time       | Mode    | Purpose                                              |
|------------|---------|------------------------------------------------------|
| 1:00 PM    | midday  | First check-in — plenty of time to course-correct    |
| 4:00 PM    | check   | Last call — push more or increase limits             |
| 9:00 PM    | recap   | End-of-day accountability — what actually happened   |

> Note: GitHub Actions cron uses UTC. The workflow file is set up for EDT (UTC-4). When DST ends in November, the UTC offsets will need to bump by 1 hour.

## Status Thresholds

| Status        | Threshold     | Meaning                                           |
|---------------|---------------|---------------------------------------------------|
| 🟢 Green      | 90%+          | All good, no action needed                        |
| 🟡 Yellow     | 70–89%        | Heads up, check campaigns and inboxes             |
| 🔴 Red        | Below 70%     | Action required — increase limits or activate     |
| ⚠️ Over       | 100%+         | Hit capacity — increase limits to send more       |

## Setup (One-Time)

### 1. Add Repository Secrets

Go to **Settings → Secrets and variables → Actions** and add these four secrets:

| Secret Name         | Value                                                              |
|---------------------|--------------------------------------------------------------------|
| `INSTANTLY_API_KEY` | The REBM workspace API key                                         |
| `RESEND_API_KEY`    | Your Resend API key                                                |
| `SHEET_WEBAPP_URL`  | The Google Apps Script web app URL for the logging sheet           |
| `ALERT_RECIPIENTS`  | Comma-separated email addresses (e.g. `brendan@growtoro.com,...`)  |

### 2. Google Sheet Setup

The sheet at `1KHzess-rPdLim_kA9YV69uQHRIqPf20mkh24NRWHhY8` is set up with an Apps Script web app that accepts POST requests with this JSON shape:

```json
{
  "date": "2026-04-10",
  "runType": "midday",
  "totalAccounts": 202,
  "dailyCapacity": 6060,
  "sentToday": 5400,
  "utilizationPct": 89.11,
  "status": "YELLOW"
}
```

Headers in row 1: `Timestamp | Date | Run Type | Total Accounts | Daily Capacity | Sent Today | Utilization % | Status`

### 3. Test Manually

Once secrets are added:
1. Go to **Actions → REBM Instantly Capacity Check**
2. Click **Run workflow**
3. Pick a run mode (or leave default)
4. Click **Run workflow** again
5. Watch the logs — you should see accounts fetched, sheet logged, and email sent
6. Check `brendan@growtoro.com` and `carla@growtoro.com` for the alert

## Local Testing

```bash
export INSTANTLY_API_KEY="..."
export RESEND_API_KEY="..."
export SHEET_WEBAPP_URL="..."
export ALERT_RECIPIENTS="brendan@growtoro.com,carla@growtoro.com"
export FROM_EMAIL="alerts@revival.ai"
export WORKSPACE_NAME="REBM"
export RUN_MODE="midday"

node scripts/check.js
```

## Architecture

```
GitHub Actions Cron (3x daily)
        ↓
   scripts/check.js (Node 20, zero deps)
        ↓
   ┌────┴────────────────┐
   ↓                      ↓
Instantly API v2       (parallel)
   ↓                      ↓
Google Sheet          Resend API
(via Apps Script)     (email alerts)
```

Zero npm dependencies. Uses Node 20's built-in `fetch`. Runs in under 30 seconds.

## Future Enhancements (v1.1+)

- Add the other 2 Instantly workspaces (loop through workspace API keys)
- Day-over-day comparison ("yesterday: 8,400 / today: 7,200, down 14%")
- Per-inbox alerts when individual accounts get paused or error
- Weekly summary email with trends from the sheet
- Slack integration if/when needed

## Troubleshooting

**"❌ FATAL ERROR: Instantly API 401"** → API key is wrong or revoked. Check the `INSTANTLY_API_KEY` secret.

**"❌ FATAL ERROR: Resend error 422"** → Sender domain not verified or recipient invalid. Check Resend dashboard.

**"⚠️ Failed to log to sheet"** → Apps Script web app URL is wrong, was redeployed (URL changes!), or hit a quota. Re-deploy and update the secret.

**No email arrived but logs show success** → Check spam folder. Add `alerts@revival.ai` to contacts.

**Numbers don't match Instantly UI** → The Instantly UI sometimes lags by a few minutes. Run the workflow again in 5 minutes.

---

Built by Growtoro for REBM · April 2026
