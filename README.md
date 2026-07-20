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

### 1. Slack App を作成してトークンを取得（マニフェスト方式・おすすめ）

スコープを1つずつクリックせず、[`slack-app-manifest.yml`](./slack-app-manifest.yml) を貼り付けて一括設定します。

1. https://api.slack.com/apps を開く（Slack にログインした状態で）。
2. **Create New App** → **From a manifest** を選ぶ。
3. トークンを取りたい**ワークスペースを選択** → Next。
4. フォーマットを **YAML** に切り替え、`slack-app-manifest.yml` の中身を丸ごと貼り付け → Next → Create。
5. 左メニュー **OAuth & Permissions** を開き、上部の **Install to Workspace** → 内容を確認して **許可する**。
6. 表示された **User OAuth Token**（`xoxp-...` で始まる）をコピーする。これが `SLACK_TOKEN` です。

> スコープを手動で設定したい場合は、User Token Scopes に次を追加します:
> `channels:read`, `channels:history`, `groups:read`, `groups:history`,
> `im:read`, `im:history`, `mpim:read`, `mpim:history`, `search:read`, `users:read`

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
```

または、リポジトリ直下に `.env` を置く方法（トークンを起動コマンドに書かずに済む・おすすめ）:

```bash
cp .env.example .env      # .env を作成
# .env を開いて SLACK_TOKEN=xoxp-... を実際のトークンに書き換える
npm start                 # サーバーが .env を自動で読み込む
```

`.env` は `.gitignore` 済みなのでコミットされません。`.env` の場所はこのリポジトリの**直下**（`src/` の隣、`.env.example` と同じ場所）です。

`[slack-mcp] running on stdio` と出れば起動 OK です（stdin を待ち続けるので Ctrl+C で終了）。

## Claude Code への登録

`.env` を使う場合はトークンを渡さずに登録できます:

```bash
claude mcp add slack --scope user -- node /ABSOLUTE/PATH/TO/slack-mcp/src/index.js
```

`.env` を使わず直接渡す場合:

```bash
claude mcp add slack --scope user --env SLACK_TOKEN=xoxp-... -- node /ABSOLUTE/PATH/TO/slack-mcp/src/index.js
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
- `fetch failed`: Slack の認証エラーではなくネットワーク遮断です。Claude Code のサンドボックスが
  MCP サーバープロセスの通信をブロックしている場合に起きます。`~/.claude/settings.json` に
  Slack を許可ドメインとして追加してください:

  ```json
  {
    "sandbox": {
      "network": {
        "allowedDomains": ["slack.com", "*.slack.com"]
      }
    }
  }
  ```

  切り分け方: `node -e 'fetch("https://slack.com/api/api.test").then(r=>console.log(r.status))'`
  がターミナルでは成功するのに MCP 経由だけ `fetch failed` になるなら、この設定が原因です。

## ライセンス

MIT
