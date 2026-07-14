# DEPLOY — Proxmox 移行手順と引き継ぎ

> **2026-07-14 現在の本番は Tailscale Serve + systemd（tailnet閉域）**。
> Cloudflare Tunnel/Access関連の実装・設定例は旧構成との互換用であり、現在は使わない。
> `CF_ACCESS_*` 未設定を起動エラーやアクセス拒否に変更してはいけない。

dev 環境（このリポジトリを開発したマシン）から Proxmox へ移行するための完全な手順書。
アーキテクチャ・設計判断・地雷は `CONTEXT.md` を先に読むこと。この2つのドキュメントだけで
引き継ぎが完結するように書いてある（開発マシンの Claude Code メモリには依存しない）。

## 現状サマリ（2026-07-14 時点）

- ブランチ `nextjs-rewrite`。Next.js 16 + SQLite（better-sqlite3 + Drizzle）。
- 実装済み: カレンダー/タスク統合・AI アシスタント（提案→承認→実行、スレッド、モデル選択、
  見積りフライホイール）・かんばん・サブタスク（GitHub sub-issue 風）・ntfy 通知・
  ダークテーマ/レスポンシブ/左ドック UI・Tailscale Serve閉域運用。
- エージェントは個人所有の単一ホスト内で実行する。別OSユーザー・別コンテナ・永続ジョブワーカーへの分離は現在の要件外。

## 必要スペック

LXC コンテナで十分（非特権 OK、GPU 不要 — LLM はクラウド API）。

| 項目 | 推奨 |
|---|---|
| vCPU / RAM / Disk | 2 vCPU / 4GB / 16GB（4GB あればコンテナ内で `next build` 可能） |
| OS / Node | Debian 12 等 + Node 20 以上（22 LTS 推奨） |
| パッケージ | `git python3 make g++`（better-sqlite3 のビルド保険）、`curl` |

実測: 本番サーバー約160MB、claude CLI 1呼び出しピーク約315MB、`next build` ピーク約2.1GB。

## 移行手順

### 1. アプリ

```bash
git clone -b nextjs-rewrite https://github.com/Oka-Tak/gcal-tasks.git /opt/kairos
cd /opt/kairos && npm ci && npm run build
```

### 2. git 外ファイルのコピー（最重要）

dev 機の **dev サーバーを停止してから**、以下を scp 等でコピーする:

| ファイル | 中身 | 注意 |
|---|---|---|
| `.env.local` | 認証情報一式 | 下記の変更が必要 |
| `kairos.db` + `kairos.db-wal` + `kairos.db-shm` | **蓄積ナレッジ本体**（チャット履歴・ライフログ・見積り実績・提案履歴） | 3点セットで。コピーしないと AI の較正がゼロからになる |
| `data/` | アップロードしたスクショ | |

### 3. `.env.local` の変更点

```bash
AUTH_URL=https://<Tailscale Serveで使うtailnet内URL>
TZ=Asia/Tokyo
# CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD は現在の本番では設定しない
# ntfy を self-host したら KAIROS_NTFY_URL も差し替え
```

**Google Cloud Console** の OAuth クライアントに本番 URL のリダイレクト URI を追加登録すること:
- `https://<tailnet内URL>/api/auth/callback/google`
- `https://<tailnet内URL>/api/connect/callback`

### 4. CLI エージェント

```bash
# claude / codex をインストールし、SSH 上で一度ログイン
# （表示される URL を手元のブラウザで開いてコードを貼る方式で headless でも通る）
claude   # 初回対話ログイン
codex login
```

### 5. systemd サービス

```ini
# /etc/systemd/system/kairos.service
[Unit]
Description=Kairos
After=network-online.target

[Service]
WorkingDirectory=/opt/kairos
Environment=NODE_ENV=production
Environment=TZ=Asia/Tokyo
# 127.0.0.1 バインド: Tailscale Serve 経由だけで到達させる
ExecStart=/usr/bin/npm run start -- -H 127.0.0.1 -p 3000
Restart=on-failure
User=kairos

[Install]
WantedBy=multi-user.target
```

DB マイグレーションは起動時に自動適用される（`lib/db/index.ts` の `migrate()`）。
リマインダーループも起動時に自動開始（`instrumentation.ts`）。

### 6. Tailscale Serve

1. Proxmox ホストを利用者の tailnet に参加させる。
2. Tailscale Serve で tailnet 内の HTTPS URL を `http://127.0.0.1:3000` へ転送する。
3. Funnelなどのインターネット公開は有効にしない。

アプリ側でも Auth.js の Google ログインと `ALLOWED_EMAILS` を使う。`proxy.ts` の Cloudflare Access検証は
旧構成との互換用であり、現在は `CF_ACCESS_*` を未設定にする。

### 7. ntfy（通知）

- 手軽: `KAIROS_NTFY_URL=https://ntfy.sh` + 長いランダムなトピック名（実質パスワード）
- self-host: Proxmox に ntfy を立てて URL を差し替え（必要なら `KAIROS_NTFY_TOKEN`）
- スマホの ntfy アプリで同じトピックを購読 → アプリ内 アカウント → 「テスト送信」で確認

### 8. 動作確認チェックリスト

- [ ] `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/` → **200**（ログイン画面が返る）
- [ ] tailnet 内 URL にブラウザでアクセス → Google ログイン → カレンダー表示
- [ ] 予定・タスクの作成/編集が Google に反映される
- [ ] AI タブでチャット（claude CLI が動く）→ 提案 → 承認で実行
- [ ] タスクにリマインド設定 → 時刻にスマホへプッシュ
- [ ] `sudo -u kairos claude -p "test"` が通る（サービスユーザーでの CLI 認証）

## 運用メモ

- **バックアップ対象**: `kairos.db`（3点セット）・`data/`・`.env.local`。Proxmox のスナップショット or
  vzdump に載せれば十分。
- 同期は画面を開いたときにオンデマンド実行（アカウント数×カレンダー数の Google API 呼び出し）。
  重く感じたらバックグラウンド同期化が「次の候補」にある。
- トークン失効したアカウントは同期がスキップされ画面から消える → 再ログインで復帰（CONTEXT.md 落とし穴）。

## 残タスク（ロードマップ）

1. **Nextcloud agentic（将来候補）**
   - ユーザー決定済み: エージェントのファイル編集は **Nextcloud にあるファイルのみ**
   - OneDrive ⇄ Nextcloud は rclone bisync（または abraunegg/onedrive）+ Nextcloud 外部ストレージで橋渡し
   - 別OSユーザー・コンテナ・永続ワーカーへの分離は現在の個人1台構成には導入しない。将来、
     インターネット公開や複数利用者対応へ変更するときに再評価する
2. **Gmail 連携（下書きのみ）** — 方針決定済み: `gmail.readonly` + 下書き作成のみ（送信スコープは
   取らない）、HTML はテキスト化して渡す・添付は開かない（ゼロデイ対策）、処理はワーカー側で
3. その他候補: バックグラウンド同期、予定の D&D 移動/リサイズ、サブタスクの並べ替え・親付け替え
   （`tasks.move`）、CSP の nonce 化、Web Push（PWA）化

## 開発の作法（Proxmox 上で開発を続ける場合）

- 新機能の前に `CONTEXT.md` を読む。Next.js 16 は訓練データと異なるので
  `node_modules/next/dist/docs/` を参照（AGENTS.md 参照）
- タスク/予定の書き込みは必ず `lib/mutations.ts` 経由。対話チャット由来の変更は
  `proposals` + `lib/actions.ts` で検証・承認する。夜間のタスク推定・サブタスク自動分割などの
  バックグラウンド自動化と経費画像のクイックキャプチャは、既存ガードレールの下で直接書き込む
- **UI の実機検証テク**: ヘッドレス Chrome + 自前発行のセッション JWT でログイン済み画面を操作できる
  （`@auth/core/jwt` の `encode`、salt は cookie 名 `authjs.session-token`、secret は AUTH_SECRET。
  cookie をセットして puppeteer-core で操作）。このリポジトリの開発中に多用した
- スキーマ変更は `lib/db/schema.ts` を編集 → `npm run db:generate` → 起動時に自動適用。
  local-only 列は `lib/sync.ts` の `googleFields` に入れなければ同期で保護される
