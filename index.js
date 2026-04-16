const { App } = require("@slack/bolt");
require("dotenv").config();

// --- Config ---
const ANDY_USER_ID = process.env.ANDY_USER_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

const employees = {
  wiki: {
    fireUrl: process.env.WIKI_FIRE_URL,
    token: process.env.WIKI_TOKEN,
    patterns: ["wiki"],
  },
  fred: {
    fireUrl: process.env.FRED_FIRE_URL,
    token: process.env.FRED_TOKEN,
    patterns: ["fred"],
  },
  marklite: {
    fireUrl: process.env.MARKLITE_FIRE_URL,
    token: process.env.MARKLITE_TOKEN,
    patterns: ["mark-lite", "marklite", "mark lite"],
  },
};

// --- Slack app (Socket Mode -- no public URL needed) ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// --- Routing logic ---

// Agent reports start with "NAME --" (e.g. "WIKI --", "FRED --", "MARK-LITE --").
// The Routines-side agents post back to Slack using Andy's user OAuth token, so
// their messages pass the `message.user === ANDY_USER_ID` filter below. Without
// this guard the bridge re-fires each agent on its own reports (Wiki looped ~14
// times on 2026-04-16 for exactly this reason).
const AGENT_REPORT_PATTERN = /^(wiki|fred|mark-?lite)\s*--/i;

// Try to identify which employee a message is for.
// Priority 1: message starts with employee name ("Wiki, what's the status?")
// Priority 2: message is a reply in a thread started by an employee
function identifyEmployee(text) {
  const lower = (text || "").toLowerCase().trim();
  for (const [name, config] of Object.entries(employees)) {
    for (const pattern of config.patterns) {
      // Check if message starts with the employee name (with optional comma/colon)
      if (lower.startsWith(pattern)) {
        return name;
      }
    }
  }
  return null;
}

function identifyEmployeeFromReport(text) {
  const lower = (text || "").toLowerCase();
  // Employee reports start with their name: "WIKI --", "FRED --", "MARK-LITE --"
  if (lower.startsWith("wiki")) return "wiki";
  if (lower.startsWith("fred")) return "fred";
  if (lower.startsWith("mark-lite") || lower.startsWith("marklite")) return "marklite";
  // Also check for "Mercia Flooring --" style responses from wiki
  if (lower.includes("wiki entry") || lower.includes("wiki updated")) return "wiki";
  return null;
}

async function getThreadParentText(channel, threadTs) {
  try {
    const result = await app.client.conversations.replies({
      channel: channel,
      ts: threadTs,
      limit: 1,
      inclusive: true,
    });
    if (result.messages && result.messages.length > 0) {
      return result.messages[0].text || "";
    }
  } catch (err) {
    console.error("Failed to read thread parent:", err.message);
  }
  return "";
}

// Redact the trigger ID in URLs for log safety (keep the prefix for debugging,
// hide the rest). Example: .../routines/trig_01AB…/fire
function redactFireUrl(url) {
  if (!url) return "<unset>";
  return url.replace(/(trig_[A-Za-z0-9]{4})[A-Za-z0-9]+/, "$1…");
}

// --- Fire the routine ---
async function fireRoutine(employeeName, messageText) {
  const employee = employees[employeeName];
  if (!employee || !employee.fireUrl || !employee.token) {
    console.log(`Skipping ${employeeName} -- no URL or token configured`);
    return null;
  }
  const redactedUrl = redactFireUrl(employee.fireUrl);
  console.log(
    `Firing ${employeeName} -> ${redactedUrl} with: "${messageText.substring(0, 80)}..."`
  );
  try {
    const response = await fetch(employee.fireUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${employee.token}`,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: messageText }),
    });

    // Log non-2xx loudly -- silent 404s from a wrong FIRE_URL have bitten us.
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "<unreadable body>");
      console.error(
        `Fire failed for ${employeeName}: HTTP ${response.status} ${response.statusText} ` +
          `from ${redactedUrl} -- body: ${bodyText.substring(0, 500)}`
      );
      return null;
    }

    const data = await response.json();
    if (data.claude_code_session_url) {
      console.log(`Session started: ${data.claude_code_session_url}`);
      return data;
    } else {
      console.error(
        `Unexpected response from ${employeeName} (HTTP ${response.status}):`,
        data
      );
      return null;
    }
  } catch (err) {
    console.error(`Failed to fire ${employeeName} (${redactedUrl}):`, err.message);
    return null;
  }
}

// --- Message listener ---
app.message(async ({ message }) => {
  // Only process messages in #ttai-employees
  if (message.channel !== CHANNEL_ID) return;

  // Only process messages from Andy (ignore bot messages and other users)
  if (message.user !== ANDY_USER_ID) return;

  // Ignore message edits, deletes, etc.
  if (message.subtype) return;

  const text = message.text || "";

  // Skip agent reports (e.g. "WIKI -- 2026-04-16 Scan ..."). Agents post as
  // Andy, so the user-ID filter above doesn't exclude them; without this guard
  // Wiki loops on its own reports.
  if (AGENT_REPORT_PATTERN.test(text.trim())) {
    console.log(
      `Ignoring agent report (self-post loop guard): "${text.substring(0, 60)}..."`
    );
    return;
  }

  console.log(`\nAndy said: "${text}"`);

  // Priority 1: message explicitly names an employee
  let target = identifyEmployee(text);

  // Priority 2: message is a thread reply -- check who started the thread
  if (!target && message.thread_ts) {
    const parentText = await getThreadParentText(message.channel, message.thread_ts);
    target = identifyEmployeeFromReport(parentText);
    if (target) {
      console.log(`Routed to ${target} via thread context`);
    }
  }

  if (!target) {
    console.log("Could not identify target employee. Message ignored.");
    console.log(
      'Tip: start with "Wiki," "Fred," or "Mark-Lite," or reply in an employee\'s thread.'
    );
    return;
  }

  // Fire the routine
  const result = await fireRoutine(target, text);

  if (result) {
    // React with eyes emoji to confirm the message was picked up
    try {
      await app.client.reactions.add({
        channel: message.channel,
        name: "eyes",
        timestamp: message.ts,
      });
    } catch (err) {
      // Reaction might fail if already added, that's fine
    }
  }
});

// --- Start ---
(async () => {
  await app.start();
  console.log("TTAI Slack Bridge is running");
  console.log(`Watching channel: ${CHANNEL_ID}`);
  console.log(`Routing messages from: ${ANDY_USER_ID}`);
  console.log(
    `Employees configured: ${
      Object.entries(employees)
        .filter(([, e]) => e.fireUrl && e.token)
        .map(([name]) => name)
        .join(", ") || "none yet"
    }`
  );
})();
