#!/usr/bin/env node
// slack-mcp — an MCP server that reads Slack (channels, DMs, threads, search)
// using a Slack user token (xoxp-...). Communicates over stdio.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

/** Normalize a Slack message into a compact shape for the model. */
function shapeMessage(m) {
  const out = {
    ts: m.ts,
    time: tsToIso(m.ts),
    user: userLabel(m.user) || m.username || m.bot_id || "unknown",
    text: m.text || "",
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
        text: m.text || "",
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[slack-mcp] running on stdio");
