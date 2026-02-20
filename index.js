const express = require("express");
const { LinearClient } = require("@linear/sdk");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const LINEAR_TEAM_NAME = process.env.LINEAR_TEAM_NAME; // e.g. "Engineering"

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getLinearUserByEmail(linear, email) {
  const organization = await linear.organization;
  const members = await organization.members();
  return members.nodes.find(
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

  // Find the Linear user matching this Slack user's email
  const linearUser = await getLinearUserByEmail(linear, slackUserEmail);
  if (!linearUser) {
    return { error: `No Linear account found for *${slackUserEmail}*. Make sure your Slack and Linear emails match.` };
  }

  const { start, end } = todayRange();

  // Issues the user completed today (moved to a "completed" or "done" state)
  const completedResult = await linear.issues({
    filter: {
      assignee: { id: { eq: linearUser.id } },
      completedAt: { gte: start, lte: end },
    },
    first: 50,
  });

  // Issues also updated/moved to in-progress today (state changed today, not completed)
  const movedResult = await linear.issues({
    filter: {
      assignee: { id: { eq: linearUser.id } },
      updatedAt: { gte: start, lte: end },
      completedAt: { null: true },
      canceledAt: { null: true },
      state: { type: { in: ["started", "inProgress"] } },
    },
    first: 50,
  });

  // Top 5 upcoming todos by priority (not started / todo)
  const upcomingResult = await linear.issues({
    filter: {
      assignee: { id: { eq: linearUser.id } },
      state: { type: { in: ["unstarted", "backlog"] } },
      canceledAt: { null: true },
      completedAt: { null: true },
    },
    orderBy: "priority",
    first: 5,
  });

  const completedIssues = completedResult.nodes;
  const movedIssues = movedResult.nodes;
  const upcomingIssues = upcomingResult.nodes;

  return { linearUser, completedIssues, movedIssues, upcomingIssues };
}

function buildSlackBlocks(data, requesterName) {
  const { linearUser, completedIssues, movedIssues, upcomingIssues } = data;
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

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

  // ── Completed today ──
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*✅ Completed Today* (${completedIssues.length})` },
  });

  if (completedIssues.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Nothing completed today yet_" } });
  } else {
    for (const issue of completedIssues) {
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

  // ── In progress / moved today ──
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*🔄 In Progress / Moved Today* (${movedIssues.length})` },
  });

  if (movedIssues.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No tickets moved today_" } });
  } else {
    for (const issue of movedIssues) {
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
    elements: [{ type: "mrkdwn", text: "💡 Add any blockers, video updates, or context not in Linear as a reply to this message." }],
  });

  return blocks;
}

// ─── Slash Command Handler ─────────────────────────────────────────────────────

app.post("/eod", async (req, res) => {
  const { user_name, user_id, response_url } = req.body;

  // Respond immediately to Slack (must reply within 3 seconds)
  res.json({
    response_type: "ephemeral",
    text: "⏳ Generating your EOD report, one sec...",
  });

  try {
    // Get the Slack user's email via Slack API
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

    // Post publicly to the channel
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
