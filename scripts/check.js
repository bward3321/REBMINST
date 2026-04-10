#!/usr/bin/env node
/**
 * REBM Instantly Capacity Check
 * ------------------------------
 * Pulls all email accounts + daily limits from Instantly API v2,
 * sums today's sent volume, calculates utilization, logs to Google Sheet,
 * and sends an alert email via Resend.
 *
 * Run modes (auto-detected from current EDT hour, override with RUN_MODE env):
 *   - midday   (1pm EDT) - first check-in, plenty of time to act
 *   - check    (4pm EDT) - second check-in, last call to push more
 *   - recap    (9pm EDT) - end of day recap, accountability
 *
 * Required environment variables:
 *   INSTANTLY_API_KEY      - REBM workspace API key
 *   RESEND_API_KEY         - Resend API key
 *   SHEET_WEBAPP_URL       - Google Apps Script web app URL
 *   ALERT_RECIPIENTS       - Comma-separated email addresses
 *   FROM_EMAIL             - Sender (e.g. alerts@revival.ai)
 *   WORKSPACE_NAME         - Display name (e.g. "REBM")
 */

const INSTANTLY_API_BASE = "https://api.instantly.ai/api/v2";

// ---------- CONFIG ----------
const config = {
  instantlyApiKey: process.env.INSTANTLY_API_KEY,
  resendApiKey: process.env.RESEND_API_KEY,
  sheetWebappUrl: process.env.SHEET_WEBAPP_URL,
  alertRecipients: (process.env.ALERT_RECIPIENTS || "").split(",").map(e => e.trim()).filter(Boolean),
  fromEmail: process.env.FROM_EMAIL || "alerts@revival.ai",
  workspaceName: process.env.WORKSPACE_NAME || "REBM",
};

// Validate config up front, fail loud
function validateConfig() {
  const missing = [];
  if (!config.instantlyApiKey) missing.push("INSTANTLY_API_KEY");
  if (!config.resendApiKey) missing.push("RESEND_API_KEY");
  if (!config.sheetWebappUrl) missing.push("SHEET_WEBAPP_URL");
  if (config.alertRecipients.length === 0) missing.push("ALERT_RECIPIENTS");
  if (missing.length > 0) {
    console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ---------- TIME / RUN MODE ----------
function getEdtNow() {
  // Current time in America/New_York
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const lookup = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    hour: parseInt(lookup.hour, 10),
    minute: parseInt(lookup.minute, 10),
    pretty: `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute} EDT`,
  };
}

function detectRunMode() {
  if (process.env.RUN_MODE) return process.env.RUN_MODE;
  const { hour } = getEdtNow();
  // 1pm = midday, 4pm = check, 9pm = recap. Allow 1-hour fuzz.
  if (hour >= 12 && hour < 14) return "midday";
  if (hour >= 15 && hour < 17) return "check";
  if (hour >= 20 || hour < 2) return "recap";
  return "midday"; // default fallback
}

const RUN_MODE_LABELS = {
  midday: { label: "Midday Check-In (1 PM EDT)", emoji: "☀️" },
  check:  { label: "Afternoon Check (4 PM EDT)", emoji: "🕓" },
  recap:  { label: "End-of-Day Recap (9 PM EDT)", emoji: "🌙" },
};

// ---------- INSTANTLY API ----------
async function instantlyGet(path, params = {}) {
  const url = new URL(`${INSTANTLY_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${config.instantlyApiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instantly API ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

/**
 * Pull every email account in the workspace, paginating through all pages.
 * Returns array of account objects.
 */
async function fetchAllAccounts() {
  const accounts = [];
  let startingAfter = undefined;
  let page = 0;
  const maxPages = 50; // safety guard - 50 * 100 = 5000 accounts

  while (page < maxPages) {
    page++;
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const data = await instantlyGet("/accounts", params);

    // Instantly v2 returns { items: [...], next_starting_after: "..." }
    const items = data.items || data.data || data || [];
    if (!Array.isArray(items)) {
      console.error("Unexpected response shape from /accounts:", JSON.stringify(data).slice(0, 500));
      break;
    }
    accounts.push(...items);

    const next = data.next_starting_after;
    if (!next || items.length === 0) break;
    startingAfter = next;
  }

  return accounts;
}

/**
 * Pull today's sent count across all accounts in the workspace.
 * Returns the total `sent` value summed across the response.
 */
async function fetchTodaysSentTotal(date) {
  const data = await instantlyGet("/accounts/analytics/daily", {
    start_date: date,
    end_date: date,
  });
  // Response is an array of { date, email_account, sent, bounced }
  if (!Array.isArray(data)) {
    console.error("Unexpected response shape from /accounts/analytics/daily:", JSON.stringify(data).slice(0, 500));
    return 0;
  }
  return data.reduce((sum, row) => sum + (row.sent || 0), 0);
}

// ---------- STATUS / THRESHOLDS ----------
function getStatus(utilizationPct) {
  if (utilizationPct >= 100) return { code: "OVER",   label: "Over Capacity",  emoji: "⚠️", color: "#9333EA",
    message: "You hit capacity. Consider increasing daily sending limits across campaigns to send more tomorrow." };
  if (utilizationPct >= 90)  return { code: "GREEN",  label: "All Good",       emoji: "🟢", color: "#16A34A",
    message: "Sending volume is at target. No action needed." };
  if (utilizationPct >= 70)  return { code: "YELLOW", label: "Heads Up",       emoji: "🟡", color: "#EAB308",
    message: "Trending below capacity. Check that all campaigns are active and inboxes aren't paused." };
  return                            { code: "RED",    label: "Action Required", emoji: "🔴", color: "#DC2626",
    message: "Significantly below capacity. Get into Instantly now — increase sending limits, activate paused campaigns, or check for errors." };
}

// ---------- GOOGLE SHEET LOGGING ----------
async function logToSheet(payload) {
  try {
    const res = await fetch(config.sheetWebappUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    const text = await res.text();
    console.log(`📊 Sheet response: ${res.status} ${text.slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.error("⚠️  Failed to log to sheet:", err.message);
    return false; // non-fatal
  }
}

// ---------- EMAIL VIA RESEND ----------
function buildEmailHtml({ runMode, runLabel, runEmoji, date, totalAccounts, dailyCapacity, sentToday, utilizationPct, status, workspaceName }) {
  const remaining = Math.max(0, dailyCapacity - sentToday);
  const utilizationBar = Math.min(100, Math.round(utilizationPct));

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f4f6f8;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

      <!-- Header -->
      <div style="background:${status.color};padding:24px;color:#ffffff;">
        <div style="font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;opacity:0.9;">${runEmoji} ${runLabel}</div>
        <div style="font-size:24px;font-weight:700;margin-top:6px;">${workspaceName} Workspace · ${date}</div>
        <div style="font-size:32px;font-weight:800;margin-top:14px;">${status.emoji} ${status.label}</div>
      </div>

      <!-- Big number -->
      <div style="padding:28px 24px 12px 24px;text-align:center;">
        <div style="font-size:13px;text-transform:uppercase;color:#6B7280;letter-spacing:0.5px;font-weight:600;">Capacity Utilization</div>
        <div style="font-size:56px;font-weight:800;color:${status.color};margin-top:4px;line-height:1;">${utilizationPct.toFixed(1)}%</div>
        <div style="margin-top:14px;background:#E5E7EB;border-radius:99px;height:10px;overflow:hidden;">
          <div style="background:${status.color};height:100%;width:${utilizationBar}%;"></div>
        </div>
      </div>

      <!-- Stats grid -->
      <div style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #E5E7EB;">
              <div style="font-size:13px;color:#6B7280;font-weight:600;">Sent Today</div>
            </td>
            <td style="padding:12px 0;border-bottom:1px solid #E5E7EB;text-align:right;">
              <div style="font-size:18px;color:#111827;font-weight:700;">${sentToday.toLocaleString()}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #E5E7EB;">
              <div style="font-size:13px;color:#6B7280;font-weight:600;">Daily Capacity</div>
            </td>
            <td style="padding:12px 0;border-bottom:1px solid #E5E7EB;text-align:right;">
              <div style="font-size:18px;color:#111827;font-weight:700;">${dailyCapacity.toLocaleString()}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #E5E7EB;">
              <div style="font-size:13px;color:#6B7280;font-weight:600;">Remaining</div>
            </td>
            <td style="padding:12px 0;border-bottom:1px solid #E5E7EB;text-align:right;">
              <div style="font-size:18px;color:#111827;font-weight:700;">${remaining.toLocaleString()}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 0;">
              <div style="font-size:13px;color:#6B7280;font-weight:600;">Active Email Accounts</div>
            </td>
            <td style="padding:12px 0;text-align:right;">
              <div style="font-size:18px;color:#111827;font-weight:700;">${totalAccounts.toLocaleString()}</div>
            </td>
          </tr>
        </table>
      </div>

      <!-- Action box -->
      <div style="margin:0 24px 24px 24px;padding:18px;background:#F9FAFB;border-left:4px solid ${status.color};border-radius:6px;">
        <div style="font-size:13px;font-weight:700;color:${status.color};text-transform:uppercase;letter-spacing:0.5px;">What To Do</div>
        <div style="font-size:15px;color:#374151;margin-top:6px;line-height:1.5;">${status.message}</div>
      </div>

      <!-- Footer -->
      <div style="padding:16px 24px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF;text-align:center;">
        REBM Instantly Capacity Monitor · Built by Growtoro · <a href="https://app.instantly.ai" style="color:#9CA3AF;">Open Instantly →</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function sendEmail({ subject, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.fromEmail,
      to: config.alertRecipients,
      subject,
      html,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend error ${res.status}: ${JSON.stringify(body)}`);
  }
  console.log(`📧 Email sent to ${config.alertRecipients.join(", ")} (id: ${body.id})`);
  return body;
}

// ---------- MAIN ----------
async function main() {
  validateConfig();

  const runMode = detectRunMode();
  const { label: runLabel, emoji: runEmoji } = RUN_MODE_LABELS[runMode] || RUN_MODE_LABELS.midday;
  const { date, pretty } = getEdtNow();

  console.log(`\n🚀 REBM Instantly Check`);
  console.log(`   Run mode: ${runMode} (${runLabel})`);
  console.log(`   Date:     ${pretty}\n`);

  // Step 1: Pull all accounts
  console.log("📡 Fetching all email accounts...");
  const accounts = await fetchAllAccounts();
  console.log(`   Found ${accounts.length} accounts`);

  // Step 2: Sum daily limits
  // Try common field names: daily_limit, dailyLimit
  const dailyCapacity = accounts.reduce((sum, a) => {
    const limit = a.daily_limit ?? a.dailyLimit ?? a.daily_send_limit ?? 0;
    return sum + (typeof limit === "number" ? limit : parseInt(limit, 10) || 0);
  }, 0);
  console.log(`   Total daily capacity: ${dailyCapacity.toLocaleString()}`);

  // Step 3: Pull today's sent total
  console.log(`\n📡 Fetching today's sent volume (${date})...`);
  const sentToday = await fetchTodaysSentTotal(date);
  console.log(`   Sent today: ${sentToday.toLocaleString()}`);

  // Step 4: Calculate utilization & status
  const utilizationPct = dailyCapacity > 0 ? (sentToday / dailyCapacity) * 100 : 0;
  const status = getStatus(utilizationPct);
  console.log(`\n📊 Utilization: ${utilizationPct.toFixed(1)}% (${status.code} - ${status.label})`);

  // Step 5: Log to Google Sheet
  console.log(`\n📝 Logging to Google Sheet...`);
  await logToSheet({
    date,
    runType: runMode,
    totalAccounts: accounts.length,
    dailyCapacity,
    sentToday,
    utilizationPct: parseFloat(utilizationPct.toFixed(2)),
    status: status.code,
  });

  // Step 6: Send email
  console.log(`\n📧 Sending alert email...`);
  const html = buildEmailHtml({
    runMode, runLabel, runEmoji,
    date,
    totalAccounts: accounts.length,
    dailyCapacity,
    sentToday,
    utilizationPct,
    status,
    workspaceName: config.workspaceName,
  });
  const subject = `${status.emoji} ${config.workspaceName}: ${utilizationPct.toFixed(1)}% capacity · ${runLabel}`;
  await sendEmail({ subject, html });

  console.log(`\n✅ Done.\n`);
}

main().catch(err => {
  console.error("\n❌ FATAL ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
