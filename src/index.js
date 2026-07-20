#!/usr/bin/env node
// slack-mcp — an MCP server that reads Slack (channels, DMs, threads, search)
// using a Slack user token (xoxp-...). Communicates over stdio.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Load a .env file from the project root as a fallback so the token can live in
// a file instead of the launch command. Explicitly-set env vars always win.
if (!process.env.SLACK_TOKEN && !process.env.SLACK_USER_TOKEN) {
  const envPath = join(import.meta.dirname, "..", ".env");
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // ignore malformed/unreadable .env
    }
  }
}

const SLACK_TOKEN = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN;
const API_BASE = "https://slack.com/api/";

if (!SLACK_TOKEN) {
  console.error(
    "[slack-mcp] Missing SLACK_TOKEN. Set a Slack user token (xoxp-...) in the SLACK_TOKEN env var."
  );
  process.exit(1);
}

/**
 * Call a Slack Web API method. Reads use GET with query params.
 * Throws on transport errors or Slack `ok: false` responses.
 */
async function slackApi(method, params = {}) {
  const url = new URL(method, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Slack API HTTP ${res.status} for ${method}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error for ${method}: ${data.error}`);
  }
  return data;
}

/**
 * Call a Slack Web API method that mutates state. Uses a form-encoded POST body:
 * every Slack method accepts that, whereas JSON bodies are only supported by some
 * (reactions.add among the holdouts).
 */
async function slackPost(method, body = {}) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null && v !== "") form.set(k, String(v));
  }
  const res = await fetch(new URL(method, API_BASE), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      // no charset: Slack warns `superfluous_charset` when it is spelled out
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Slack API HTTP ${res.status} for ${method}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error for ${method}: ${data.error}`);
  }
  return data;
}

// --- user name resolution (cached for the process lifetime) ---
const userCache = new Map(); // id -> { name, real_name }

async function resolveUsers(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !userCache.has(id));
  for (const id of missing) {
    try {
      const { user } = await slackApi("users.info", { user: id });
      userCache.set(id, {
        name: user.name,
        real_name: user.profile?.real_name || user.real_name || user.name,
      });
    } catch {
      userCache.set(id, { name: id, real_name: id });
    }
  }
}

function userLabel(id) {
  if (!id) return null;
  const u = userCache.get(id);
  return u ? `${u.real_name} (@${u.name})` : id;
}

function tsToIso(ts) {
  if (!ts) return null;
  const seconds = Number(String(ts).split(".")[0]);
  return new Date(seconds * 1000).toISOString();
}

/**
 * Walk a Block Kit tree collecting human-readable strings. Bots (GitHub,
 * CircleCI, ...) put their content in blocks/attachments and leave `text` empty.
 */
function collectBlockText(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectBlockText(n, out);
    return;
  }
  if (typeof node.text === "string") {
    if (node.text.trim()) out.push(node.text.trim());
  } else if (node.text) {
    collectBlockText(node.text, out);
  }
  if (node.type === "link" && node.url && !node.text) out.push(node.url);
  for (const key of ["elements", "fields", "blocks"]) {
    if (node[key]) collectBlockText(node[key], out);
  }
}

/** Best-effort message body: plain text, else blocks, else attachments. */
function extractText(m) {
  if (m.text && m.text.trim()) return m.text;

  const parts = [];
  if (m.blocks) collectBlockText(m.blocks, parts);

  for (const a of m.attachments || []) {
    const seg = [a.pretext, a.title, a.text].filter((s) => s && s.trim());
    // fallback is a flattened duplicate — only useful when nothing else exists
    if (seg.length) parts.push(seg.join(" — "));
    else if (a.fallback?.trim()) parts.push(a.fallback.trim());
  }

  // drop consecutive duplicates (blocks and attachments often mirror each other)
  return parts.filter((s, i) => s !== parts[i - 1]).join("\n").trim();
}

/** Normalize a Slack message into a compact shape for the model. */
function shapeMessage(m) {
  const out = {
    ts: m.ts,
    time: tsToIso(m.ts),
    user: userLabel(m.user) || m.username || m.bot_id || "unknown",
    text: extractText(m),
  };
  if (m.thread_ts && m.thread_ts !== m.ts) out.in_thread = m.thread_ts;
  if (m.reply_count) out.reply_count = m.reply_count;
  if (m.thread_ts && m.thread_ts === m.ts && m.reply_count) out.is_thread_parent = true;
  if (m.files?.length) out.files = m.files.map((f) => f.name || f.title);
  if (m.reactions?.length)
    out.reactions = m.reactions.map((r) => `${r.name}:${r.count}`);
  return out;
}

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: "slack-mcp", version: "0.1.0" });

// --- who am I ---
server.registerTool(
  "slack_whoami",
  {
    title: "Slack: who am I",
    description:
      "Return the identity and workspace tied to the current token (auth.test). Useful for verifying the token works.",
    inputSchema: {},
  },
  async () => {
    const data = await slackApi("auth.test");
    return jsonResult({
      user: data.user,
      user_id: data.user_id,
      team: data.team,
      team_id: data.team_id,
      url: data.url,
    });
  }
);

// --- list channels / conversations ---
server.registerTool(
  "slack_list_channels",
  {
    title: "Slack: list channels",
    description:
      "List conversations the token can see. `types` is a comma list of: public_channel, private_channel, im (DMs), mpim (group DMs). Returns id, name, and type flags. Use the returned id with slack_get_history.",
    inputSchema: {
      types: z
        .string()
        .optional()
        .describe("Comma list. Default: public_channel,private_channel"),
      limit: z.number().int().min(1).max(1000).optional().describe("Default 200"),
      cursor: z.string().optional().describe("Pagination cursor from a prior call"),
    },
  },
  async ({ types, limit, cursor }) => {
    const data = await slackApi("conversations.list", {
      types: types || "public_channel,private_channel",
      limit: limit || 200,
      cursor,
      exclude_archived: true,
    });
    // Resolve the other party for DMs.
    await resolveUsers(data.channels.filter((c) => c.is_im).map((c) => c.user));
    const channels = data.channels.map((c) => ({
      id: c.id,
      name: c.is_im ? `DM: ${userLabel(c.user)}` : c.name || c.id,
      type: c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private ? "private" : "public",
      is_member: c.is_member,
    }));
    return jsonResult({
      channels,
      next_cursor: data.response_metadata?.next_cursor || null,
    });
  }
);

// --- channel history ---
server.registerTool(
  "slack_get_history",
  {
    title: "Slack: get channel history",
    description:
      "Read recent messages from a channel or DM by id. Thread parents show reply_count — use slack_get_thread to expand them. Paginate with next_cursor.",
    inputSchema: {
      channel: z.string().describe("Channel/conversation id (e.g. C0123 or D0123)"),
      limit: z.number().int().min(1).max(200).optional().describe("Default 30"),
      oldest: z.string().optional().describe("Only messages after this ts"),
      latest: z.string().optional().describe("Only messages before this ts"),
      cursor: z.string().optional().describe("Pagination cursor from a prior call"),
    },
  },
  async ({ channel, limit, oldest, latest, cursor }) => {
    const data = await slackApi("conversations.history", {
      channel,
      limit: limit || 30,
      oldest,
      latest,
      cursor,
    });
    await resolveUsers(data.messages.map((m) => m.user));
    return jsonResult({
      channel,
      messages: data.messages.map(shapeMessage),
      next_cursor: data.response_metadata?.next_cursor || null,
    });
  }
);

// --- thread replies ---
server.registerTool(
  "slack_get_thread",
  {
    title: "Slack: get thread replies",
    description:
      "Expand a thread: returns the parent message plus all replies, given the channel id and the parent's thread_ts (the `ts` of a message with reply_count).",
    inputSchema: {
      channel: z.string().describe("Channel/conversation id"),
      thread_ts: z.string().describe("The parent message ts"),
      limit: z.number().int().min(1).max(200).optional().describe("Default 100"),
    },
  },
  async ({ channel, thread_ts, limit }) => {
    const data = await slackApi("conversations.replies", {
      channel,
      ts: thread_ts,
      limit: limit || 100,
    });
    await resolveUsers(data.messages.map((m) => m.user));
    return jsonResult({
      channel,
      thread_ts,
      messages: data.messages.map(shapeMessage),
      next_cursor: data.response_metadata?.next_cursor || null,
    });
  }
);

// --- activity in a time window (thread-aware) ---
server.registerTool(
  "slack_get_activity",
  {
    title: "Slack: get activity in a time window",
    description:
      "Everything that happened in a channel since `oldest`, INCLUDING replies to threads that were started before the window. Use this instead of slack_get_history when summarizing a period (e.g. 'what happened this week'), since history alone returns only top-level messages and misses ongoing thread discussions.",
    inputSchema: {
      channel: z.string().describe("Channel/conversation id"),
      oldest: z.string().describe("Unix ts marking the start of the window"),
      latest: z.string().optional().describe("Unix ts marking the end of the window"),
      lookback_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("How far before the window to scan for thread parents. Default 90"),
      max_threads: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Cap on threads expanded. Default 20"),
    },
  },
  async ({ channel, oldest, latest, lookback_days, max_threads }) => {
    const from = Number(oldest);
    const to = latest ? Number(latest) : Infinity;
    const scanFloor = from - (lookback_days ?? 90) * 86400;
    const threadCap = max_threads ?? 20;

    // Page back far enough to see thread parents that predate the window.
    const scanned = [];
    let cursor;
    let truncated = false;
    for (let page = 0; page < 10; page++) {
      const data = await slackApi("conversations.history", {
        channel,
        limit: 200,
        latest,
        cursor,
      });
      scanned.push(...data.messages);
      const oldestSeen = data.messages.at(-1);
      cursor = data.response_metadata?.next_cursor;
      if (!cursor || !oldestSeen || Number(oldestSeen.ts) < scanFloor) break;
      if (page === 9) truncated = true;
    }

    const inWindow = (ts) => Number(ts) >= from && Number(ts) <= to;

    const topLevel = scanned.filter((m) => inWindow(m.ts));

    // Candidate threads: any activity at or after the window start, and started
    // before the window ends. Deliberately NOT `latest_reply in window` — a thread
    // can have replies inside the window while its newest reply falls after it.
    // Replies are filtered to the window below, so over-selecting here is safe.
    const activeThreads = scanned
      .filter(
        (m) =>
          m.reply_count &&
          m.latest_reply &&
          Number(m.latest_reply) >= from &&
          Number(m.ts) <= to
      )
      .slice(0, threadCap);

    const threadUpdates = [];
    for (const parent of activeThreads) {
      const data = await slackApi("conversations.replies", {
        channel,
        ts: parent.ts,
        limit: 200,
      });
      const replies = data.messages.filter((m) => m.ts !== parent.ts && inWindow(m.ts));
      if (!replies.length) continue;
      await resolveUsers([parent.user, ...replies.map((m) => m.user)]);
      threadUpdates.push({
        parent: shapeMessage(parent),
        parent_started_before_window: Number(parent.ts) < from,
        new_replies: replies.map(shapeMessage),
      });
    }

    await resolveUsers(topLevel.map((m) => m.user));

    return jsonResult({
      channel,
      window: { from: tsToIso(oldest), to: latest ? tsToIso(latest) : "now" },
      messages: topLevel.map(shapeMessage),
      thread_updates: threadUpdates,
      scan_truncated: truncated || undefined,
    });
  }
);

// --- search ---
server.registerTool(
  "slack_search",
  {
    title: "Slack: search messages",
    description:
      "Full-text search across the workspace (search.messages). Requires a user token with search:read. Supports Slack search operators like in:#channel, from:@user, after:2024-01-01.",
    inputSchema: {
      query: z.string().describe("Search query, e.g. 'deploy in:#eng from:@alice'"),
      count: z.number().int().min(1).max(100).optional().describe("Results per page, default 20"),
      page: z.number().int().min(1).optional().describe("1-based page, default 1"),
    },
  },
  async ({ query, count, page }) => {
    const data = await slackApi("search.messages", {
      query,
      count: count || 20,
      page: page || 1,
      sort: "timestamp",
    });
    const matches = data.messages?.matches || [];
    await resolveUsers(matches.map((m) => m.user));
    return jsonResult({
      query,
      total: data.messages?.total || 0,
      page: data.messages?.paging?.page || 1,
      pages: data.messages?.paging?.pages || 1,
      matches: matches.map((m) => ({
        ts: m.ts,
        time: tsToIso(m.ts),
        channel: m.channel?.name ? `#${m.channel.name}` : m.channel?.id,
        channel_id: m.channel?.id,
        user: userLabel(m.user) || m.username || "unknown",
        text: extractText(m),
        permalink: m.permalink,
      })),
    });
  }
);

// --- list users ---
server.registerTool(
  "slack_list_users",
  {
    title: "Slack: list users",
    description:
      "List workspace members (id, handle, real name). Paginate with next_cursor.",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).optional().describe("Default 200"),
      cursor: z.string().optional().describe("Pagination cursor from a prior call"),
    },
  },
  async ({ limit, cursor }) => {
    const data = await slackApi("users.list", { limit: limit || 200, cursor });
    return jsonResult({
      users: data.members
        .filter((u) => !u.deleted)
        .map((u) => ({
          id: u.id,
          name: u.name,
          real_name: u.profile?.real_name || u.real_name || u.name,
          is_bot: u.is_bot,
        })),
      next_cursor: data.response_metadata?.next_cursor || null,
    });
  }
);

// --- post a message ---
server.registerTool(
  "slack_post_message",
  {
    title: "Slack: post a message",
    description:
      "Post a message to a channel or DM as the token's user. Pass thread_ts (a parent message's ts) to reply in a thread instead of the channel. Returns the new message's ts and permalink.",
    inputSchema: {
      channel: z.string().describe("Channel/conversation id (e.g. C0123 or D0123)"),
      text: z.string().describe("Message body. Supports Slack mrkdwn."),
      thread_ts: z
        .string()
        .optional()
        .describe("Parent message ts — set this to reply inside that thread"),
      reply_broadcast: z
        .boolean()
        .optional()
        .describe("With thread_ts, also surface the reply in the channel. Default false"),
    },
  },
  async ({ channel, text, thread_ts, reply_broadcast }) => {
    const data = await slackPost("chat.postMessage", {
      channel,
      text,
      thread_ts,
      reply_broadcast: reply_broadcast || undefined,
    });
    let permalink = null;
    try {
      const link = await slackApi("chat.getPermalink", {
        channel: data.channel,
        message_ts: data.ts,
      });
      permalink = link.permalink;
    } catch {
      // permalink is a convenience — the post already succeeded
    }
    return jsonResult({
      ok: true,
      channel: data.channel,
      ts: data.ts,
      thread_ts: thread_ts || undefined,
      permalink,
    });
  }
);

// --- add a reaction ---
server.registerTool(
  "slack_add_reaction",
  {
    title: "Slack: add a reaction",
    description:
      "Add an emoji reaction to a message, given its channel id and ts. Use the emoji name without colons (e.g. 'eyes', '+1').",
    inputSchema: {
      channel: z.string().describe("Channel/conversation id"),
      ts: z.string().describe("Target message ts"),
      name: z.string().describe("Emoji name without colons, e.g. 'white_check_mark'"),
    },
  },
  async ({ channel, ts, name }) => {
    await slackPost("reactions.add", {
      channel,
      timestamp: ts,
      name: name.replace(/:/g, ""),
    });
    return jsonResult({ ok: true, channel, ts, reaction: name });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[slack-mcp] running on stdio");
