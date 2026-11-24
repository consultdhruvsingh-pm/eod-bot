// Morning plan: posts each developer's in-progress work and next tasks from
// Linear to a Slack channel. Runs as a Render Cron Job on weekday mornings and
// exits when done, so it does not touch the /eod web service in index.js.

const { LinearClient } = require("@linear/sdk");

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const MORNING_CHANNEL = process.env.MORNING_CHANNEL;
// Comma-separated work emails, the same in Slack and Linear. Kept in the
// environment rather than the repo because the repo is public.
const MORNING_DEVS = process.env.MORNING_DEVS || "";
// DRY_RUN=1 prints the post instead of sending it.
const DRY_RUN = process.env.DRY_RUN === "1";
// Off by default. Set MORNING_ENABLED=1 to post the morning plan again.
const MORNING_ENABLED = process.env.MORNING_ENABLED === "1";

const TIMEZONE = "Asia/Kolkata";
const NEXT_UP_COUNT = 3;
const IN_PROGRESS_SHOWN = 5;
const IN_PROGRESS_LIMIT = 3;
const STALE_AFTER_WORKING_DAYS = 2;
const TITLE_MAX_CHARS = 100;

// ─── Linear ───────────────────────────────────────────────────────────────────

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

// One raw query for everyone's open issues. The SDK's model objects would load
// each issue's state and assignee with a separate request.
const OPEN_ISSUES_QUERY = `
  query MorningOpenIssues($assigneeIds: [ID!], $after: String) {
    issues(
      first: 100
      after: $after
      filter: {
        assignee: { id: { in: $assigneeIds } }
        state: { type: { in: ["started", "unstarted"] }, name: { neq: "In Review" } }
      }
    ) {
      nodes {
        identifier
        title
        url
        priority
        dueDate
        createdAt
        updatedAt
        assignee { id }
        state { name type }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function getOpenIssues(linear, assigneeIds) {
  const issues = [];
  let after = null;
  for (;;) {
    const res = await linear.client.rawRequest(OPEN_ISSUES_QUERY, { assigneeIds, after });
    const page = res.data.issues;
    issues.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return issues;
    after = page.pageInfo.endCursor;
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function slackApi(method, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function getSlackUserIdByEmail(email) {
  // users.lookupByEmail only accepts form-encoded arguments, not JSON.
  const res = await fetch("https://slack.com/api/users.lookupByEmail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ email }),
  });
  const data = await res.json();
  return data.ok ? data.user.id : null;
}

// ─── Plan logic ───────────────────────────────────────────────────────────────

function priorityRank(p) {
  return p === 0 ? 99 : p;
}

function priorityEmoji(p) {
  return ["⚪", "🔴", "🟠", "🔵", "🟢"][p] ?? "⚪";
}

/** Highest priority first, then the oldest ticket. */
function compareNext(a, b) {
  if (a.priority !== b.priority) return priorityRank(a.priority) - priorityRank(b.priority);
  return a.createdAt < b.createdAt ? -1 : 1;
}

/** The instant n working days (Mon–Fri) before `date`. */
function subtractWorkingDays(date, n) {
  const d = new Date(date);
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n--;
  }
  return d;
}

function summarizeDev(issues, now) {
  const inProgress = issues
    .filter((i) => i.state.type === "started")
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  const todo = issues.filter((i) => i.state.name === "Todo").sort(compareNext);

  const flags = [];
  if (inProgress.length === 0) flags.push("Nothing in progress");
  if (inProgress.length > IN_PROGRESS_LIMIT) flags.push(`${inProgress.length} in progress`);
  if (todo.length === 0) flags.push("Nothing in Todo");

  return {
    inProgress,
    nextUp: todo.slice(0, NEXT_UP_COUNT),
    staleBefore: subtractWorkingDays(now, STALE_AFTER_WORKING_DAYS),
    flags,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatDay(value) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: TIMEZONE,
  });
}

/** Linear due dates are plain YYYY-MM-DD dates with no time or zone. */
function formatDueDate(dueDate) {
  return new Date(`${dueDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Slack treats <, > and & as markup, e.g. a title quoting "<script>". */
function escapeMrkdwn(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortTitle(title) {
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : title;
}

function issueLink(issue) {
  return `${priorityEmoji(issue.priority)} *<${issue.url}|${issue.identifier}>* ${escapeMrkdwn(shortTitle(issue.title))}`;
}

function inProgressLine(issue, staleBefore) {
  const stale = new Date(issue.updatedAt) < staleBefore;
  return `${issueLink(issue)}${stale ? ` · _no update since ${formatDay(issue.updatedAt)}_` : ""}`;
}

function nextUpLine(issue, index, today) {
  const tags = [];
  if (issue.dueDate) {
    tags.push(
      issue.dueDate < today
        ? `overdue, due ${formatDueDate(issue.dueDate)}`
        : `due ${formatDueDate(issue.dueDate)}`
    );
  }
  const suffix = tags.length ? ` · _${tags.join(" · ")}_` : "";
  return `${index + 1}. ${issueLink(issue)}${suffix}`;
}

function devLines(dev, now) {
  const who = dev.slackUserId ? `<@${dev.slackUserId}>` : escapeMrkdwn(dev.name);

  if (!dev.summary) {
    return [`*${who}* · ⚠️ No Linear account found for ${dev.email}`];
  }

  const { inProgress, nextUp, staleBefore, flags } = dev.summary;
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const lines = [`*${who}*${flags.map((f) => ` · ⚠️ ${f}`).join("")}`];

  if (inProgress.length > 0) {
    lines.push("*🔄 In progress*");
    lines.push(...inProgress.slice(0, IN_PROGRESS_SHOWN).map((i) => inProgressLine(i, staleBefore)));
    if (inProgress.length > IN_PROGRESS_SHOWN) {
      lines.push(`_…and ${inProgress.length - IN_PROGRESS_SHOWN} more_`);
    }
  }
  if (nextUp.length > 0) {
    lines.push("*⏭ Next up*");
    lines.push(...nextUp.map((i, idx) => nextUpLine(i, idx, today)));
  }
  return lines;
}

/** Split lines into section blocks that stay under Slack's 3000-char mrkdwn limit. */
function pushLineSections(blocks, lines) {
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

function buildBlocks(devs, now) {
  const date = new Date(now).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: TIMEZONE,
  });

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `☀️ Plan for ${date}`, emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `From Linear: what each developer has in progress and their next ${NEXT_UP_COUNT} tasks. Reply in this thread if your plan for today is different.`,
        },
      ],
    },
    { type: "divider" },
  ];

  for (const dev of devs) {
    pushLineSections(blocks, devLines(dev, now));
    blocks.push({ type: "divider" });
  }
  return { text: `☀️ Plan for ${date}`, blocks };
}

function blocksToText(blocks) {
  return blocks
    .map((b) => {
      if (b.type === "divider") return "────────";
      if (b.type === "context") return b.elements.map((e) => e.text).join(" ");
      return b.text.text;
    })
    .join("\n");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!MORNING_ENABLED && !DRY_RUN) {
    console.log("Morning plan is disabled (set MORNING_ENABLED=1 to turn it on). Not posting.");
    return;
  }

  const emails = MORNING_DEVS.split(",").map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) throw new Error("MORNING_DEVS is empty");
  if (!DRY_RUN && !MORNING_CHANNEL) throw new Error("MORNING_CHANNEL is not set");

  const now = new Date();
  const linear = new LinearClient({ apiKey: LINEAR_API_KEY });

  const devs = await Promise.all(
    emails.map(async (email) => {
      const [linearUser, slackUserId] = await Promise.all([
        getLinearUserByEmail(linear, email),
        getSlackUserIdByEmail(email),
      ]);
      if (!linearUser) console.warn(`No Linear account for ${email}`);
      if (!slackUserId) console.warn(`No Slack account for ${email}`);
      return { email, linearUser, slackUserId, name: linearUser?.name ?? email };
    })
  );

  const found = devs.filter((d) => d.linearUser);
  const issues = await getOpenIssues(linear, found.map((d) => d.linearUser.id));
  for (const dev of found) {
    dev.summary = summarizeDev(
      issues.filter((i) => i.assignee?.id === dev.linearUser.id),
      now
    );
  }

  const message = buildBlocks(devs, now);

  if (DRY_RUN) {
    console.log(blocksToText(message.blocks));
    return;
  }

  const res = await slackApi("chat.postMessage", { channel: MORNING_CHANNEL, ...message });
  if (!res.ok) throw new Error(`Slack chat.postMessage failed: ${res.error}`);
  console.log(`Posted morning plan for ${devs.length} developers to ${MORNING_CHANNEL}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Morning plan failed:", err);
    process.exit(1);
  });
}

module.exports = { summarizeDev, buildBlocks, blocksToText, compareNext, subtractWorkingDays };
