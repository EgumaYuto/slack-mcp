---
name: slack-reader
description: Read and post to Slack via the slack-mcp server — list channels, read channel/DM history, expand threads, search the workspace, and post messages, thread replies, or reactions. Use whenever the user asks to look up, summarize, or find something in Slack ("what did X say in #channel", "search Slack for ..."), or to send/reply/react in Slack.
---

# Slack

Access to Slack through the `slack-mcp` MCP server. Requires the server to be
registered (tools named `slack_*`) with a Slack **user token** (xoxp-).

## Available tools

### Reading

- `slack_whoami` — verify the token / identify the workspace.
- `slack_list_channels` — get channel & DM ids. `types` = comma list of
  `public_channel,private_channel,im,mpim`.
- `slack_get_history` — read recent messages of a channel/DM by id.
- `slack_get_activity` — everything in a time window, including replies to threads
  started before it. Use this for "what happened this week" style summaries.
- `slack_get_thread` — expand a thread (needs channel id + parent `thread_ts`).
- `slack_search` — workspace full-text search with operators.
- `slack_list_users` — resolve members.

### Writing

- `slack_post_message` — post to a channel/DM. Pass `thread_ts` to reply in a thread.
- `slack_add_reaction` — add an emoji reaction (name without colons).
- `slack_update_message` — replace the body of a message the user authored.
- `slack_delete_message` — delete a message the user authored. Irreversible.

## How to work

1. **Resolve names to ids first.** Users refer to channels by name ("#general")
   or people by handle, but history/thread tools need ids. Use
   `slack_list_channels` (or `slack_search` with `in:#name`) to get the id.
2. **Read history** with `slack_get_history`. Default limit is small (30) —
   raise `limit` or paginate via the returned `next_cursor` when the user wants
   more history. For a *time range* ("this week", "since Monday") use
   `slack_get_activity` instead: `slack_get_history` returns only top-level
   messages, so ongoing thread discussions are silently missed.
3. **Threads:** messages with `reply_count` are thread parents. To read the full
   discussion, call `slack_get_thread` with that message's `ts` as `thread_ts`.
4. **Search** with `slack_search`. Prefer Slack operators to narrow results:
   - `in:#channel` / `in:@dm`
   - `from:@user`
   - `after:2024-01-01` / `before:2024-12-31` / `on:2024-06-01`
   - quote phrases: `"exact phrase"`
   Search returns `permalink` — include it when citing a message.
5. **Posting:** show the user the exact text and the target channel, and get their
   confirmation, before calling `slack_post_message` — the message goes out under
   their own name and cannot be un-sent (only deleted after the fact). To reply in
   a thread rather than the channel, pass the parent's `ts` as `thread_ts`.
6. **Editing/deleting:** only the token's own messages can be changed. Deletion is
   permanent — always confirm the specific message with the user first.

## Notes

- Writes act **as the user**, not as a bot. Treat every post as something the user
  is personally saying in their workspace.
- A user token reads only what that user can already see; private channels the
  user hasn't joined return `channel_not_found`.
- Timestamps come back as both raw `ts` and ISO `time`. Use `ts`/`thread_ts`
  for follow-up API calls, ISO for showing the user.
- Bot posts (GitHub, CircleCI, ...) carry their content in `blocks`/`attachments`
  rather than `text`; the server extracts it, so these can be verbose.
- Free Slack plans expose only ~90 days of history. Older messages return nothing
  from history/activity even though the channel clearly has them.
- If tools are missing, the server isn't registered — point the user to the
  slack-mcp README setup steps.
