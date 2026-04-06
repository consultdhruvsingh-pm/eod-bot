const express = require("express");
const { LinearClient } = require("@linear/sdk");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getLinearUserByEmail(linear, email) {
  const trimmed = email.trim();
  if (!trimmed) return undefined;

  const byFilter = await linear.users({
    first: 5,
    filter: { email: { eqIgnoreCase: trimmed } },
  });
  if (byFilter.nodes.length > 0) return byFilter.nodes[0];

  const needle = trimmed.toLowerCase();
  let page = await linear.users({ first: 250 });
  for (;;) {
    const match = page.nodes.find((m) => m.email?.toLowerCase() === needle);
    if (match) return match;
    if (!page.pageInfo.hasNextPage) return undefined;
    page = await page.fetchNext();
  }
}

/** First UTC instant where `timeZone` reads as `y-mo-d` (ISO date). */
function utcMsStartOfLocalDay(timeZone, y, mo, d) {
  const target = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  let lo = Date.UTC(y, mo - 1, d) - 8 * 86400000;
  let hi = Date.UTC(y, mo - 1, d) + 8 * 86400000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const s = new Date(mid).toLocaleDateString("sv-SE", { timeZone });
    if (s < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First UTC instant on the next calendar day in `timeZone` after `startMs`. */
function utcMsStartOfNextLocalDay(timeZone, startMs) {
  const currentTarget = new Date(startMs).toLocaleDateString("sv-SE", { timeZone });
  let lo = startMs;
  let hi = startMs + 48 * 3600000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const s = new Date(mid).toLocaleDateString("sv-SE", { timeZone });
    if (s <= currentTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function todayRange(tz) {
  if (!tz) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = +parts.find((p) => p.type === "year").value;
  const mo = +parts.find((p) => p.type === "month").value;
  const d = +parts.find((p) => p.type === "day").value;
  const startMs = utcMsStartOfLocalDay(tz, y, mo, d);
  const nextMs = utcMsStartOfNextLocalDay(tz, startMs);
  return { start: new Date(startMs), end: new Date(nextMs - 1) };
}

function priorityLabel(p) {
  return ["No priority", "Urgent", "High", "Normal", "Low"][p] ?? "Unknown";
}

function priorityEmoji(p) {
  return ["⚪", "🔴", "🟠", "🔵", "🟢"][p] ?? "⚪";
}

async function getEODData(slackUserEmail, userTimezone) {
  const linear = new LinearClient({ apiKey: LINEAR_API_KEY });
  const linearUser = await getLinearUserByEmail(linear, slackUserEmail);

  if (!linearUser) {
    return {
      error: `No Linear account found for *${slackUserEmail}*. Make sure your Slack and Linear emails match.`,
    };
  }

  const { start, end } = todayRange(userTimezone);

  const [completedResult, inReviewResult, activeResult, upcomingResult] =
    await Promise.all([
      linear.issues({
        filter: {
          assignee: { id: { eq: linearUser.id } },
          completedAt: { gte: start, lte: end },
        },
        first: 50,
      }),
      linear.issues({
        filter: {
          assignee: { id: { eq: linearUser.id } },
          completedAt: { null: true },
          canceledAt: { null: true },
          state: { name: { eq: "In Review" } },
        },
        first: 50,
      }),
      linear.issues({
        filter: {
          assignee: { id: { eq: linearUser.id } },
          completedAt: { null: true },
          canceledAt: { null: true },
          state: { type: { eq: "started" }, name: { neq: "In Review" } },
        },
        first: 50,
      }),
      linear.issues({
        filter: {
          assignee: { id: { eq: linearUser.id } },
          state: { type: { in: ["unstarted", "backlog"] } },
          canceledAt: { null: true },
          completedAt: { null: true },
        },
        first: 50,
      }),
    ]);

  const completedIssues = completedResult.nodes;
  const completedIds = new Set(completedIssues.map((i) => i.id));
  const inReviewIssues = inReviewResult.nodes.filter(
    (i) => !completedIds.has(i.id)
  );
  const activeIssues = activeResult.nodes.filter(
    (i) => !completedIds.has(i.id)
  );
  const upcomingIssues = upcomingResult.nodes
    .sort((a, b) => {
      const pa = a.priority === 0 ? 99 : a.priority;
      const pb = b.priority === 0 ? 99 : b.priority;
      return pa - pb;
    })
    .slice(0, 5);

  return {
    linearUser,
    completedIssues,
    inReviewIssues,
    activeIssues,
    upcomingIssues,
  };
}

function issueLine(issue) {
  return `${priorityEmoji(issue.priority)} *<${issue.url}|${issue.identifier}>* ${issue.title}`;
}

/** Split lines into section blocks that stay under Slack's 3000-char mrkdwn limit. */
function pushLineSections(blocks, lines) {
  if (lines.length === 0) return;
  let buf = "";
  for (const line of lines) {
    if (buf.length + line.length + 1 > 2900 && buf.length > 0) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
  }
}

function buildSlackBlocks(data, requesterName, userTimezone) {
  const { linearUser, completedIssues, inReviewIssues, activeIssues, upcomingIssues } = data;

  const dateOpts = { weekday: "long", month: "long", day: "numeric" };
  if (userTimezone) dateOpts.timeZone = userTimezone;
  const today = new Date().toLocaleDateString("en-US", dateOpts);

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `📋 EOD Report — ${today}`, emoji: true },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Requested by *${requesterName}* · Linear: *${linearUser.name}*` },
      ],
    },
    { type: "divider" },
  ];

  // ── Done today (completed/merged + in review/PR open) ──
  const doneIssues = [
    ...completedIssues.map((i) => ({ issue: i, tag: " · _merged_" })),
    ...inReviewIssues.map((i) => ({ issue: i, tag: " · _PR open_" })),
  ];
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*✅ Done Today* (${doneIssues.length})`,
    },
  });
  if (doneIssues.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No tickets completed today_" },
    });
  } else {
    pushLineSections(
      blocks,
      doneIssues.map(({ issue, tag }) => `${issueLine(issue)}${tag}`)
    );
  }

  blocks.push({ type: "divider" });

  // ── In progress (all started-type states, including carry-over) ──
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*🔄 In Progress* (${activeIssues.length})`,
    },
  });
  if (activeIssues.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Nothing in progress_" },
    });
  } else {
    pushLineSections(blocks, activeIssues.map(issueLine));
  }

  blocks.push({ type: "divider" });

  // ── Top 5 next tasks ──
  const nextLines = upcomingIssues.map(
    (issue, i) =>
      `*${i + 1}.* ${priorityEmoji(issue.priority)} *<${issue.url}|${issue.identifier}>* ${issue.title}  _${priorityLabel(issue.priority)}_`
  );
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*🎯 Top 5 Next Tasks (by priority)*`,
    },
  });
  if (nextLines.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No upcoming tasks assigned_" },
    });
  } else {
    pushLineSections(blocks, nextLines);
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: "💡 Reply to this message with your Loom + PR link, and any blockers not captured in Linear." },
    ],
  });

  return blocks;
}

// ─── Slash Command Handler ─────────────────────────────────────────────────────

app.post("/eod", async (req, res) => {
  const { user_name, user_id, response_url } = req.body;

  res.json({
    response_type: "ephemeral",
    text: "⏳ Generating your EOD report, one sec...",
  });

  try {
    const slackRes = await fetch(
      `https://slack.com/api/users.info?user=${user_id}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const slackData = await slackRes.json();

    if (!slackData.ok || !slackData.user?.profile?.email) {
      await postToResponseUrl(response_url, {
        response_type: "ephemeral",
        text: "❌ Couldn't retrieve your Slack email. Make sure the bot has `users:read.email` scope.",
      });
      return;
    }

    const email = slackData.user.profile.email.trim();
    const displayName = slackData.user.profile.display_name || user_name;
    const userTimezone = slackData.user.tz || null;
    const data = await getEODData(email, userTimezone);

    if (data.error) {
      await postToResponseUrl(response_url, {
        response_type: "ephemeral",
        text: `❌ ${data.error}`,
      });
      return;
    }

    const blocks = buildSlackBlocks(data, displayName, userTimezone);
    await postToResponseUrl(response_url, {
      response_type: "in_channel",
      blocks,
    });

    const eodChannel = process.env.EOD_CHANNEL;
    if (eodChannel) {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel: eodChannel, blocks }),
      });
    }
  } catch (err) {
    console.error("EOD bot error:", err);
    await postToResponseUrl(response_url, {
      response_type: "ephemeral",
      text: `❌ Something went wrong: ${err.message}`,
    });
  }
});

async function postToResponseUrl(url, body) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EOD bot running on port ${PORT}`));
