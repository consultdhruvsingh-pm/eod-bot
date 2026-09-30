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

/** Cutoff for a rolling 24-hour window: the instant exactly 24h before now.
 *  Timezone-independent — "last 24 hours" is the same length everywhere, so we
 *  no longer need any local-calendar-day math. */
function last24hCutoff() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

/** When the issue last changed workflow state. The issue is currently in
 *  "In Review", so its most recent state transition is the move into review. */
async function lastStateChangeAt(issue) {
  const history = await issue.history({ first: 100 });
  let latest = null;
  for (const h of history.nodes) {
    if (h.toStateId && (!latest || h.createdAt > latest)) latest = h.createdAt;
  }
  return latest;
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
    return {
      error: `No Linear account found for *${slackUserEmail}*. Make sure your Slack and Linear emails match.`,
    };
  }

  const since = last24hCutoff();

  const [completedResult, inReviewResult, activeResult, upcomingResult, createdResult] =
    await Promise.all([
      linear.issues({
        filter: {
          assignee: { id: { eq: linearUser.id } },
          completedAt: { gte: since },
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
      linear.issues({
        filter: {
          creator: { id: { eq: linearUser.id } },
          createdAt: { gte: since },
        },
        first: 100,
      }),
    ]);

  const completedIssues = completedResult.nodes;
  const completedIds = new Set(completedIssues.map((i) => i.id));
  // Only tickets that *moved into* In Review in the last 24h count as done
  // today. Anything that's been sitting in review longer is carry-over, not
  // today's work. updatedAt >= since is a cheap pre-filter (a state change
  // bumps updatedAt) before checking history.
  const openInReview = inReviewResult.nodes.filter(
    (i) => !completedIds.has(i.id)
  );
  const movedAt = await Promise.all(
    openInReview.map((i) =>
      i.updatedAt >= since ? lastStateChangeAt(i) : Promise.resolve(null)
    )
  );
  const inReviewIssues = openInReview.filter(
    (_, idx) => movedAt[idx] && movedAt[idx] >= since
  );
  const staleInReviewIssues = openInReview.filter(
    (_, idx) => !(movedAt[idx] && movedAt[idx] >= since)
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
  const createdIssues = createdResult.nodes;

  return {
    linearUser,
    completedIssues,
    inReviewIssues,
    staleInReviewIssues,
    activeIssues,
    upcomingIssues,
    createdIssues,
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
  const { linearUser, completedIssues, inReviewIssues, staleInReviewIssues, activeIssues, upcomingIssues, createdIssues } = data;

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

  // ── Done (last 24h): completed/merged + in review/PR open ──
  const doneIssues = [
    ...completedIssues.map((i) => ({ issue: i, tag: " · _merged_" })),
    ...inReviewIssues.map((i) => ({ issue: i, tag: " · _PR open_" })),
  ];
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*✅ Done (last 24h)* (${doneIssues.length})`,
    },
  });
  if (doneIssues.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No tickets completed in the last 24h_" },
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

  // ── Still in review (moved to In Review >24h ago) — carry-over, not done today ──
  if (staleInReviewIssues.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*👀 Still In Review (>24h)* (${staleInReviewIssues.length})`,
      },
    });
    const shown = staleInReviewIssues.slice(0, 10).map(issueLine);
    if (staleInReviewIssues.length > shown.length) {
      shown.push(`_…and ${staleInReviewIssues.length - shown.length} more_`);
    }
    pushLineSections(blocks, shown);
    blocks.push({ type: "divider" });
  }

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

  // ── Issues created (last 24h) ──
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*📝 Issues Created (last 24h)* (${createdIssues.length})`,
    },
  });
  if (createdIssues.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No issues created in the last 24h_" },
    });
  } else {
    pushLineSections(blocks, createdIssues.map(issueLine));
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
    const data = await getEODData(email);

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
