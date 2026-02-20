const express = require("express");
const { LinearClient } = require("@linear/sdk");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getLinearUserByEmail(linear, email) {
  const users = await linear.users();
  return users.nodes.find(
    (m) => m.email?.toLowerCase() === email.toLowerCase()
  );
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function priorityLabel(p) {
  return ["No priority", "Urgent", "High", "Normal", "Low"][p] ?? "Unknown";
}

function priorityEmoji(p) {
  return ["⚪", "🔴", "🟠", "🔵", "🟢"][p] ?? "⚪";
}

async function getEODData(slackUserEmail) {
  const linear = new LinearClient({ apiKey: LINEAR_API_KEY });

  const linearUser = await getLinearUserByEmail(linear, slackUserEmail);
  if (!linearUser) {
    return { error: `No Linear account found for *${slackUserEmail}*. Make sure your Slack and Linear emails match.` };
  }

  const { start, end } = todayRange();

  // ── Done today: PR merged (QA state, completedAt set today) ──
  const mergedResult = await linear.issues({
    filter: {
      assignee: { id: { eq: linearUser.id } },
      completedAt: { gte: start, lte: end },
    },
    first: 50,
  });

  // ── Done today: PR open (In Review state — work is done, awaiting merge) ──
  const inReviewResult = await linear.issues({
    filter: {
      assignee: { id: { eq: linearUser.id } },
      completedAt: { null: true },
      canceledAt: { null: true },
      state: { name: { eq: "In Review" } },
    },
    first: 50,
  });

  // ── Still in progress (coding not done yet) ──
  const inProgressResult = await linear.issues({
    filter: {
      assignee: { id: { eq: linearUser.id } },
      updatedAt: { gte: start, lte: end },
      completedAt: { null: true },
      canceledAt: { null: true },
      state: { name: { eq: "In Progress" } },
    },
    first: 50,
  });

  // ── Top upcoming tasks by priority ──
  const upcomingResult = await linear.issues({
    filter: {
      assignee: { id: { eq: linearUser.id } },
      state: { type: { in: ["unstarted", "backlog"] } },
      canceledAt: { null: true },
      completedAt: { null: true },
    },
    first: 50,
  });

  const mergedIssues = mergedResult.nodes;
  const inReviewIssues = inReviewResult.nodes;
  const inProgressIssues = inProgressResult.nodes;
  const upcomingIssues = upcomingResult.nodes
    .sort((a, b) => {
      const pa = a.priority === 0 ? 99 : a.priority;
      const pb = b.priority === 0 ? 99 : b.priority;
      return pa - pb;
    })
    .slice(0, 5);

  return { linearUser, mergedIssues, inReviewIssues, inProgressIssues, upcomingIssues };
}

function buildSlackBlocks(data, requesterName) {
  const { linearUser, mergedIssues, inReviewIssues, inProgressIssues, upcomingIssues } = data;

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  // Combine merged + in review into a single "Done Today" section
  const doneIssues = [...mergedIssues, ...inReviewIssues];

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `📋 EOD Report — ${today}`, emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Requested by *${requesterName}* · Linear: *${linearUser.name}*` }],
    },
    { type: "divider" },
  ];

  // ── Done today (merged + in review) ──
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*✅ Done Today* (${doneIssues.length})` },
  });

  if (doneIssues.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No tickets completed today_" } });
  } else {
    for (const issue of doneIssues) {
      const tag = mergedIssues.includes(issue) ? " · _merged_" : " · _PR open_";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${priorityEmoji(issue.priority)} *<${issue.url}|${issue.identifier}>* ${issue.title}${tag}`,
        },
      });
    }
  }

  blocks.push({ type: "divider" });

  // ── Still in progress ──
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*🔄 In Progress* (${inProgressIssues.length})` },
  });

  if (inProgressIssues.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Nothing still in progress_" } });
  } else {
    for (const issue of inProgressIssues) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${priorityEmoji(issue.priority)} *<${issue.url}|${issue.identifier}>* ${issue.title}`,
        },
      });
    }
  }

  blocks.push({ type: "divider" });

  // ── Top 5 next tasks ──
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*🎯 Top 5 Next Tasks (by priority)*` },
  });

  if (upcomingIssues.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No upcoming tasks assigned_" } });
  } else {
    upcomingIssues.forEach((issue, i) => {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${i + 1}.* ${priorityEmoji(issue.priority)} *<${issue.url}|${issue.identifier}>* ${issue.title}\n   _Priority: ${priorityLabel(issue.priority)}_`,
        },
      });
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "💡 Reply to this message with your Loom + PR link, and any blockers not captured in Linear." }],
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

    const email = slackData.user.profile.email;
    const displayName = slackData.user.profile.display_name || user_name;

    const data = await getEODData(email);

    if (data.error) {
      await postToResponseUrl(response_url, {
        response_type: "ephemeral",
        text: `❌ ${data.error}`,
      });
      return;
    }

    const blocks = buildSlackBlocks(data, displayName);

    await postToResponseUrl(response_url, {
      response_type: "in_channel",
      blocks,
    });
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
