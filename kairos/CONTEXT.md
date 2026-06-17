# CONTEXT — Kairos 引き継ぎ

このアプリを次に触る人（人間/エージェント）への現状メモ。実装済みの設計判断と踏みやすい地雷を先に共有する。
新機能を足す前にこれを読むこと。旧 FastAPI 版は親ディレクトリ（`../`）に参照用として残っている。

## 目的

Google カレンダー + Google Tasks を1画面に統合する個人専用アプリ。最終的には Proxmox 上の個人
ダッシュボードの1コンポーネントとして動かす。旧版は「DB を持たない薄い API ブリッジ」だったが、
**タスクに時刻を持たせたい**という要求のため、本版から**ローカル DB を持つ**方針に転換した。

## 設計判断（守るべき前提）

- **DB は「Google の同期ミラー + ローカル専用カラム」。** Google が真実の源。読み取り時に Google を
  fetch して DB を upsert し、Google から消えた行は（同期した窓の中で）ソフト削除する。書き込みは
  write-through（Google に書く→その行を DB に反映）。**ローカル専用カラム**（`tasks.dueTime` ほか
  `remindAt` / `sortOrder`）は同期で**絶対に上書きしない**——これが DB を持つ理由。`lib/sync.ts` の
  `syncTasks` で、conflict 時に更新する集合から local-only 列を外しているのが要。ここを壊すと時刻が消える。
- **タスクの時刻は Kairos 内のみ。** Google Tasks API は日付粒度しか持てない（公式仕様）。`dueTime`
  ('HH:MM') は DB だけに保存し Google には送らない。よってスマホの Google 側には出ない。これはバグでなく
  原理的制約。UI のタスク編集にも明記済み。時刻付きで他端末にも出したい用事は「予定（イベント）」で作る。
- **単一「人」・複数 Google アカウント。** 利用者は1人。`accounts` テーブルに1アカウント1行、トークンは
  AES-256-GCM で暗号化（`lib/crypto.ts`、鍵は `KAIROS_ENC_KEY` を sha256 して32バイト化）。来訪者ごとの
  セッションは無く、アクセス制御は前段（Cloudflare Access）+ `ALLOWED_EMAILS` に任せる。
- **認証は2層に分離。** (1) **アプリのログイン/セッション** = Auth.js（`auth.ts`、Google プロバイダ、
  JWT セッション、`signIn` コールバックで `ALLOWED_EMAILS` ゲート）。(2) **データ取得用の Google トークン**
  = 自前の `accounts` テーブル。ログイン時にそのアカウントを `jwt` コールバックでデータソースとして登録し、
  追加アカウントは `/api/connect/google`→`/api/connect/callback`（state を cookie で照合する CSRF 対策つき）で
  足す。Auth.js の adapter は使っていない（同一プロバイダ複数アカウントの linking 沼を避けるため）。
- **書き込みは `account` 必須・パスに入れない。** 予定の識別は (account, calendarId, googleId) の3つ組で、
  calendarId に特殊文字が入るため、API は識別子を body / query で渡す（動的ルートセグメントを避けた）。

## 技術スタック / バージョン依存（重要）

- **Next.js 16**（App Router, Turbopack 既定）。**ここが訓練データと食い違う**ので注意：
  - `cookies()` / `headers()` / `params` / `searchParams` は**すべて async**（`await` 必須）。
  - Route Handler の `ctx.params` は Promise。型は `RouteContext<'/path/[id]'>`。本アプリは動的セグメントを
    使っていないので該当箇所は無いが、足すなら await すること。
  - `middleware` は `proxy` に改名・非推奨。本アプリは middleware/proxy を使わず、各 Route Handler 先頭で
    `await auth()` してゲートする（better-sqlite3 が node ランタイム必須なので各ルートに `export const
    runtime = "nodejs"`）。
  - 詳細は `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`。新規コード前に読むこと。
- React 19.2 / TypeScript 5。DB: better-sqlite3（ネイティブ）+ Drizzle ORM（`drizzle-kit generate` で
  `drizzle/` に SQL 生成、起動時 `migrate()` で自動適用）。`next.config.ts` の `serverExternalPackages` に
  better-sqlite3 を入れてバンドル除外している。
- **DB クライアントは遅延初期化**（`lib/db/index.ts` の Proxy）。import 時ではなく最初のクエリ時に SQLite を
  開く。これで `next build` 中にビルド成果物ディレクトリへ DB を作る副作用を防いでいる。

## データモデル（`lib/db/schema.ts`）

`accounts`(email PK, 暗号化トークン), `calendars`, `events`(startMs/endMs を範囲クエリ用に保持),
`tasklists`, `tasks`。mirror 系は全部 `syncedAt` / `deletedAt`（ソフト削除）を持つ。`tasks` だけ
local-only 列（`dueTime` / `remindAt` / `sortOrder`）を持つ。

## API（すべて `await auth()` でゲート、`runtime=nodejs`）

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/status` | ログイン状態 + 接続アカウント |
| GET/DELETE | `/api/accounts` | 接続アカウント一覧 / 切断（`?email`） |
| GET | `/api/connect/google`,`/api/connect/callback` | 追加アカウントの OAuth |
| GET | `/api/calendars` | ミラーから全カレンダー |
| GET | `/api/events?timeMin&timeMax` | calendars+events を同期→窓内を返す |
| POST/PATCH/DELETE | `/api/events` | 作成/更新/削除（識別子は body、DELETE は query） |
| GET | `/api/tasks` | tasklists+tasks を同期→`{lists,tasks}` を返す |
| POST/PATCH/DELETE | `/api/tasks` | 作成/更新/削除。`dueTime` は local-only で別扱い |

`/api/events` は calendars+events のみ同期（`syncAllEvents`）。tasks は `/api/tasks` 側で同期。二重同期回避のため。

## セキュリティ

`next.config.ts` の `headers()` で CSP / nosniff / Referrer-Policy / X-Frame-Options を全レスポンスに付与。
CSP の `frame-ancestors` は `FRAME_ANCESTORS` 環境変数で可変（ダッシュボード埋め込み用）。CSP は inline の
都合で `script-src`/`style-src` に `'unsafe-inline'` を許容している（残課題: nonce 化）。

## 落とし穴

- 同期は **アカウント数 × カレンダー数** に比例して Google API を叩く。`/api/events` のたびに同期する
  （即時整合性優先）。重くなったらバックグラウンド同期＋DB 即読みに切り替える余地あり。
- 期限切れ/取消トークンのアカウントは同期で握りつぶしてスキップ（`syncAllEvents` の try/catch）。UI に出ない＝
  再ログインが必要。
- 予定の編集後は「その予定の前後1日」を `syncEvents` で再取得してミラーを更新している（単一行 upsert の
  共通マッパを切らずに済ませるため）。

## 動作確認状況

ビルド（`next build`）・型チェック・起動・認証ゲート・セキュリティヘッダ・マイグレーション SQL 適用・
トークン暗号化のラウンドトリップは確認済み。**未確認**＝実際の Google OAuth ログイン以降（複数アカウント
接続・同期・予定/タスクの読み書き・タスク時刻の保存）。ブラウザで一度通すこと。

## 次の候補（要相談）

- バックグラウンド同期（cron/Route）＋ DB 即読みでの体感速度改善。
- カレンダー/アカウント別の表示オン・オフ、ドラッグ移動・リサイズ。
- リマインダ（`remindAt` 列は用意済み）・サブタスク作成（現状は表示のみ）。
- Cloudflare Access の JWT（`Cf-Access-Jwt-Assertion`）検証への格上げ。
- 旧 FastAPI 版（`../`）の撤去（このアプリが安定したら）。
