# slack-mcp

Slack を読むための [MCP](https://modelcontextprotocol.io) サーバーです。Slack の **user token (xoxp-)** を使って、チャンネル・DM・スレッド・全文検索を Claude（や他の MCP クライアント）から読み取れるようにします。

書き込み（投稿）は行いません。読み取り専用です。

## 提供ツール

| ツール | 説明 |
| --- | --- |
| `slack_whoami` | トークンの本人・ワークスペースを確認（動作確認用） |
| `slack_list_channels` | チャンネル / DM / グループDM の一覧（id を取得） |
| `slack_get_history` | チャンネル・DM の最近のメッセージを読む |
| `slack_get_thread` | スレッドの親＋返信を展開 |
| `slack_search` | ワークスペース全体を全文検索（`in:#ch from:@user` 等の演算子対応） |
| `slack_list_users` | メンバー一覧（id → 名前解決） |

## 必要なもの

- Node.js 18 以上
- Slack の **user token (xoxp-)**（検索と DM 読み取りに必須）

## セットアップ

### 1. Slack App を作成してトークンを取得

1. https://api.slack.com/apps → **Create New App** → **From scratch**。名前とワークスペースを選ぶ。
2. 左メニュー **OAuth & Permissions** を開く。
3. **Scopes → User Token Scopes** に以下を追加する（Bot Token ではなく **User Token** 側）:

   | Scope | 用途 |
   | --- | --- |
   | `channels:read` / `channels:history` | public チャンネル |
   | `groups:read` / `groups:history` | private チャンネル |
   | `im:read` / `im:history` | DM |
   | `mpim:read` / `mpim:history` | グループ DM |
   | `search:read` | 全文検索 |
   | `users:read` | ユーザー名の解決 |

4. ページ上部の **Install to Workspace**（再インストールが必要なら **Reinstall**）→ 承認。
5. **User OAuth Token**（`xoxp-...` で始まる）をコピーする。

> 注意: user token は「あなた本人」の権限で Slack を読みます。取り扱いは慎重に。

### 2. インストール

```bash
git clone https://github.com/EgumaYuto/slack-mcp.git
cd slack-mcp
npm install
```

### 3. 動作確認

```bash
SLACK_TOKEN=xoxp-... npm start
# 別の方法: cp .env.example .env で .env に書いてから起動しても良い
```

`[slack-mcp] running on stdio` と出れば起動 OK です（stdin を待ち続けるので Ctrl+C で終了）。

## Claude Code への登録

```bash
claude mcp add slack --env SLACK_TOKEN=xoxp-... -- node /ABSOLUTE/PATH/TO/slack-mcp/src/index.js
```

`claude mcp list` で `slack` が出れば登録完了です。Claude Code の中で「#general の最近のメッセージを読んで」のように依頼できます。

## Claude Desktop への登録

`claude_desktop_config.json` に追記:

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/slack-mcp/src/index.js"],
      "env": { "SLACK_TOKEN": "xoxp-..." }
    }
  }
}
```

## 同梱の Skill

`skill/slack-reader/` に、このサーバーの使い方をまとめた Claude Code 用 Skill を同梱しています。ユーザー全体で使うには:

```bash
cp -R skill/slack-reader ~/.claude/skills/
```

## トラブルシューティング

- `missing_scope`: 上記スコープを追加して **Reinstall** し、トークンを取り直す。
- `not_allowed_token_type`: `search.messages` は bot token では使えません。**user token** を使ってください。
- `invalid_auth`: トークンが失効／誤り。再取得する。
- `channel_not_found`: user token でも自分が参加していないチャンネルは読めません。

## ライセンス

MIT
