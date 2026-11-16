// Connie Tool API client shared by index.js (/eod) and morning.js.
//
// Tasks are read through the Tool API (https://api.connie.ai) with a workspace
// API key. Connie's own /api/tasks endpoints accept only a browser session, so
// a key sent there answers 401. Docs: https://docs.connie.ai/developers/tool-api

const { randomUUID } = require("node:crypto");

const CONNIE_API_URL = (process.env.CONNIE_API_URL || "https://api.connie.ai").replace(/\/+$/, "");
const CONNIE_API_KEY = process.env.CONNIE_API_KEY;
const CONNIE_WORKSPACE_ID = process.env.CONNIE_WORKSPACE_ID;

const POLL_MS = 2000;
const PAGE_SIZE = 100;

// Connie's priority words → Linear's numbers, which the Slack formatting uses
// (0 none, 1 urgent, 2 high, 3 normal/medium, 4 low).
const PRIORITY_NUMBER = { "no priority": 0, none: 0, urgent: 1, high: 2, medium: 3, normal: 3, low: 4 };

// Connie's status words → the status keys the filters take.
const STATUS_KEY = {
  triage: "triage",
  backlog: "backlog",
  "to do": "todo",
  todo: "todo",
  "in progress": "in_progress",
  "in review": "in_review",
  done: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
  duplicate: "duplicate",
};

function requireConfig() {
  if (!CONNIE_API_KEY) throw new Error("CONNIE_API_KEY is not set");
  if (!CONNIE_WORKSPACE_ID) throw new Error("CONNIE_WORKSPACE_ID is not set");
}

function authHeaders() {
  return { Authorization: `Bearer ${CONNIE_API_KEY}`, "Content-Type": "application/json" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { message: `Connie answered ${res.status}: ${text.slice(0, 200)}` } };
  }
}

/** Run one Connie tool and wait for its outcome. Reads only, so a retry is safe. */
async function runTool(toolId, input) {
  requireConfig();
  const key = randomUUID();
  const send = () =>
    fetch(`${CONNIE_API_URL}/api/tool/${encodeURIComponent(toolId)}`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": key },
      body: JSON.stringify({ input }),
    });

  let res = await send();
  let op = await readJson(res);
  // Nothing ran and Connie says the same request may be sent again (rate limit, restart).
  if (op.status === "not_executed" && op.error?.retryable) {
    await sleep(Math.min(Number(res.headers.get("retry-after") || 2), 30) * 1000);
    res = await send();
    op = await readJson(res);
  }
  while (res.status === 202) {
    await sleep(POLL_MS);
    res = await fetch(`${CONNIE_API_URL}/api/tool-invocations/${op.invocationId}`, { headers: authHeaders() });
    op = await readJson(res);
  }
  if (op.ok && op.resultRef) {
    res = await fetch(`${CONNIE_API_URL}/api/tool-invocations/${op.invocationId}?result=full`, { headers: authHeaders() });
    op = await readJson(res);
  }
  if (!op.ok) {
    const message = op.error?.message || op.error || `HTTP ${res.status}`;
    throw new Error(`Connie ${toolId} failed: ${message}`);
  }
  return op.result;
}

/**
 * The Connie member with this exact email, or undefined. Connie compares the
 * full stored address on the server; the member list itself only shows masked
 * addresses.
 */
async function getConnieMemberByEmail(email) {
  const trimmed = email.trim();
  if (!trimmed) return undefined;
  const result = await runTool("workspace-list-members", { match: [{ email: trimmed }] });
  const answer = result?.matches?.[0];
  if (!answer || answer.status !== "matched" || answer.matchedBy !== "email" || !answer.member) return undefined;
  return { id: answer.member.user_id, name: answer.member.full_name, email: trimmed };
}

function taskNumber(identifier) {
  const match = /-(\d+)$/.exec(identifier || "");
  return match ? Number(match[1]) : 0;
}

function taskUrl(task) {
  if (task.url && /^https?:\/\//.test(task.url)) {
    if (!task.url.includes(CONNIE_WORKSPACE_ID)) {
      throw new Error("CONNIE_API_KEY belongs to a different workspace than CONNIE_WORKSPACE_ID");
    }
    return task.url;
  }
  return `https://connie.ai/${CONNIE_WORKSPACE_ID}/tasks/${task.id}`;
}

/**
 * A Connie task in the shape the Slack formatting reads. Timestamps the Tool
 * API does not return yet (createdAt, completedAt, reviewRequestedAt) are null.
 */
function normalizeTask(task) {
  const statusWord = String(task.status || "").toLowerCase();
  return {
    id: task.id,
    identifier: task.identifier,
    number: taskNumber(task.identifier),
    title: task.title || "",
    url: taskUrl(task),
    priority: PRIORITY_NUMBER[String(task.priority || "").toLowerCase()] ?? 0,
    status: STATUS_KEY[statusWord] || statusWord,
    assignee: task.assignee || null,
    dueDate: task.dueDate || null,
    updatedAt: task.updatedAt || null,
    createdAt: task.createdAt || null,
    completedAt: task.completedAt || null,
    reviewRequestedAt: task.reviewRequestedAt || null,
  };
}

/** The tasks of an object-search-tasks result. A refusal comes back as a result with success: false. */
function taskList(result) {
  if (result && result.success === false) {
    throw new Error(`Connie task search refused: ${result.error?.message || result.error || result.message || "unknown reason"}`);
  }
  return Array.isArray(result?.tasks) ? result.tasks : [];
}

/**
 * Every task matching these object-search-tasks filters, across pages. With
 * `updatedSince`, only tasks updated at or after it, newest first, and paging
 * stops at the first older one (a status filter on closed tasks would
 * otherwise page through all of them).
 */
async function searchTasks(filters, { sortBy = "updated", updatedSince = null } = {}) {
  const tasks = [];
  let offset = 0;
  const order = updatedSince ? "updated" : sortBy;
  for (;;) {
    const result = await runTool("object-search-tasks", { filters, sortBy: order, maxRecords: PAGE_SIZE, offset });
    const page = taskList(result).map(normalizeTask);
    if (updatedSince) {
      const recent = page.filter((t) => t.updatedAt && new Date(t.updatedAt) >= updatedSince);
      tasks.push(...recent);
      if (recent.length < page.length) return tasks;
    } else {
      tasks.push(...page);
    }
    if (!result?.hasMore || page.length === 0) return tasks;
    offset = typeof result.nextOffset === "number" ? result.nextOffset : offset + page.length;
  }
}

/**
 * Tasks read in full by identifier (20 per call), keyed by identifier. A full
 * read carries createdAt, which the list does not.
 */
async function readTasksInFull(identifiers) {
  const byIdentifier = new Map();
  for (let i = 0; i < identifiers.length; i += 20) {
    const batch = identifiers.slice(i, i + 20);
    const result = await runTool("object-search-tasks", { query: batch.join(", ") });
    for (const task of taskList(result)) byIdentifier.set(task.identifier, normalizeTask(task));
  }
  return byIdentifier;
}

module.exports = {
  runTool,
  getConnieMemberByEmail,
  searchTasks,
  readTasksInFull,
  normalizeTask,
  requireConfig,
};
