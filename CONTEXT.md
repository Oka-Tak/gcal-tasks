# CONTEXT — Kairos 引き継ぎ

このアプリを次に触る人（人間/エージェント）への現状メモ。実装済みの設計判断と踏みやすい地雷を先に共有する。
新機能を足す前にこれを読むこと。**Proxmox への移行手順・残タスク・開発の作法は `DEPLOY.md`**
（2026-07-03 に開発拠点を dev 機 → Proxmox へ移行。この2つのドキュメントで引き継ぎが完結する）。
旧 FastAPI 版はワークツリーから撤去済み（`main` ブランチ = コミット `0f78751` に復元ポイント）。
このリポジトリのルートが Kairos 本体。

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
local-only 列（`dueTime` / `remindAt` / `sortOrder` / `kanban`、加えて見積りフライホイール用の
`estimatedMin` / `actualMin` / `difficulty` / `energy`）を持つ。`kanban` は /board の列
（todo/doing/waiting、null=todo。「完了」列だけは Google に見える status=completed で表現）。これらは Google に送らず、sync の
`googleFields` 集合にも入れていないので同期で保持される（`dueTime` と同じ仕組み）。

**ローカル専用の新テーブル（Google ミラーではない）:**
- `logs` — ライフログ/実績（sleep/meal/work/trip…）。**ナレッジの源**。`metrics`(JSON) に睡眠の質や
  各ステージ分を持つ。睡眠は Xiaomi ウォッチのスクショを claude にビジョン抽出させて作る。**ローカルのみ**
  （Google ミラー無し＝設計判断。スマホには出ない）。
- `agent_jobs` — ローカル CLI エージェント（claude/codex）呼び出しの台帳。全呼び出しを記録して履歴を
  DB に残す（Proxmox Claude Code から読める）。**今はルート内でインライン実行**して結果を書き戻すが、
  公開前にここを drain する**別プロセスのワーカー**へ移すための継ぎ目。
- `chats` — タスク別（or 汎用）の AI 会話。CLI の `--resume` ではなく **DB を真実の源**にして全履歴を残す。
  `taskKey` = "account|tasklist|googleId"（null＝汎用）。
- `proposals` — **エージェント提案の承認キュー**。チャットの返答に含まれる構造化アクション
  （create_task / update_task / create_event / update_event）を検証して保存し、UI の承認で初めて実行する。
  status: pending → done / rejected / error。無効な提案も error として残す（可視化・デバッグ用）。
  将来のメール下書き・リポジトリ修正などの agentic 実行もここに載せる設計。

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
| GET/POST/DELETE | `/api/logs` | ライフログ一覧 / 確定保存 / 削除（`?id`） |
| POST | `/api/logs/ingest` | スクショ(multipart)→保存→claude でビジョン抽出→**ドラフトを返す**（保存はしない） |
| GET/POST | `/api/chat` | AI相談。GET=`{messages,proposals}`（`?thread` or `?taskKey`）、POST=送信（`thread`/`taskKey`、`agent`=claude/codex、`model`=haiku/sonnet/opus）。全ターンを `chats` に保存 |
| GET | `/api/chat/threads` | /ai タブのトピックスレッド一覧（taskKey 無し行を threadId で集約） |
| GET/POST | `/api/notify` | 通知の設定状態 / テストプッシュ送信（ntfy） |
| GET/PATCH | `/api/proposals` | 提案一覧（`?threadId` / `?status`、既定 pending）/ 承認・却下（`{id,decision}`。approve で実行） |

`/api/events` は calendars+events のみ同期（`syncAllEvents`）。tasks は `/api/tasks` 側で同期。二重同期回避のため。

## AI エージェント連携 / ライフログ（`/logs` ページ）

- **ローカル CLI エージェント**を呼ぶ薄いラッパが `lib/agent.ts`。`runAgent(prompt, opts)` が claude/codex を
  spawn（**プロンプトは stdin・引数は argv 配列**でシェルを通さない＝注入対策）し、結果を `agent_jobs` に記録。
  claude は `-p --output-format json`（出力は `.result`）、画像は `--allowedTools Read` で Read させ、`--add-dir`
  でアップロード先を許可。モデルは `KAIROS_CLAUDE_MODEL`（既定 sonnet）。
- **スクショ取り込みフロー**（`lib/logs.ts`）: アップロード画像を `KAIROS_DATA/uploads/` に保存（gitignore・
  非公開）→ `extractSleepFromImage` が claude に JSON 抽出させる → **ドラフトを UI でプレビュー＆編集 → 確定**で
  `logs` に保存。OCR の読み違いを人間が止められるよう**必ず確認を挟む**。
- **AI アシスタントは独立タブ `/ai`**（FloorpOS 風）: 話題ごとのスレッド（threadId=`topic:<uuid>`、
  一覧はサイドバー/モバイルはチップ）＋モデル選択（haiku=既定の軽量 / sonnet / opus=旅程など重い計画用。
  UI の選択は localStorage に記憶、サーバー側でホワイトリスト検証）。チャット UI 本体は
  `app/chat-pane.tsx` に共通化され、タスク編集モーダルの「AIに相談」も同じコンポーネント。
  **段取り確認フロー**: 大きな依頼はまず計画だけを reply で提示して確認を取り、OK 後にアクションを出す
  （プロンプトで指示）。pending 提案が複数あれば「すべて承認して順に実行」で作成順に逐次実行。
- **AI 相談**（`lib/chat.ts`、UI はタスク編集モーダルの「🤖 AIに相談」＋ `/ai` タブ）:
  `chats` を真実の源にして毎回履歴からプロンプトを組み直す（CLI の `--resume` は使わない）。プロンプトには
  タスク詳細＋`logs` の要約（睡眠の平均/直近）＋**書き込み先の正当な ID 一覧・未完了タスク・今後7日の予定・
  空き時間（07:00-23:00 から予定を引いた枠）・見積り実績（est→actual の較正データ）・現在時刻**を入れる。
  claude/codex を UI で選択可。
  **codex は stdout にバナー＋tokens 行が出る**ので `exec - -o <file>` で最終メッセージだけをファイルに書かせて
  読む（`runCodex`）。claude は `--output-format json` の `.result`。エージェントは cwd=データディレクトリで
  起動するので、`runAgent` が起動前に必ずそのディレクトリを作る。
- **構造化アクション層**（`lib/actions.ts` + `lib/mutations.ts`）: チャットの返答は
  `{"reply": "...", "actions": [...]}` の JSON 契約。actions は `validateAction` で **ID の実在**（tasklists /
  書き込み可 calendars / 対象行）と形式を検証して `proposals` に保存。UI の承認カードで approve すると
  **もう一度検証してから** `lib/mutations.ts` 経由で実行する（作成/更新の write-through は REST ルートと共通。
  local-only 列の温存ロジックを二重実装しないための共有層）。エージェント出力が JSON でない場合は
  全文を reply として扱い actions 無し（graceful degradation）。**削除系アクションは意図的に未提供**。
- **見積りフライホイール（実装済み）**: タスク編集モーダルの「⏱ AIで見積り」がチャットに定型依頼を自動送信し、
  エージェントが update_task(estimatedMin) ＋空き枠内の create_event（作業枠）を提案→人間承認で確定。
  実績側はタスク編集モーダルの **見積り/実績/難易度/エネルギー** 入力（local-only 列）で記録し、完了済み＋
  実績ありのタスクが次回から「見積りと実績」としてプロンプトに入る（＝使うほどあなた仕様に較正される）。
  空き時間計算は `lib/chat.ts` の `freeSlots()`（起床時間 07:00-23:00 固定。可変にするなら env or 設定へ）。

## 通知（ntfy、2026-07-02 実装）

- `lib/notify.ts`: `sendPush()` は ntfy の **JSON エンドポイント**（サーバールートへ POST）を使う
  —— ヘッダ方式だと日本語タイトルが化けるため。設定は `KAIROS_NTFY_URL` / `KAIROS_NTFY_TOPIC`
  （＋自前サーバー保護用に `KAIROS_NTFY_TOKEN`）。未設定なら全体が静かに無効。
- **リマインダー**: `tasks.remindAt`（epoch ms）に到達すると 60 秒間隔のループがプッシュ →
  `remindedAt` に発火記録（remindAt 変更時に mutations がリセットするので再設定すれば再発火）。
  完了/削除済みタスクは発火しない。ループは `instrumentation.ts` の `register()` から起動
  （NEXT_RUNTIME=nodejs のみ・ビルド時は起動しない・`timer.unref()` 済・HMR 二重起動ガード）。
- UI: タスク編集モーダルの「リマインド通知」欄、アカウントモーダルに設定状態＋テスト送信。
  エージェントも create_task / update_task の `remindAt`（RFC3339 → ms に検証時変換）で設定可能。
- トピック名は実質パスワード（知っていれば誰でも購読/送信できる）。長いランダム文字列にすること。

## UI / レスポンシブ（2026-07-02 対応）

- **テーマはダーク「ターミナル」**（globals.css の :root トークン一式）: 背景 #0b0f14、パネル #131a22、
  アクセントはミント #2de0a7、数字/ラベル類に等幅フォント。`color-scheme:dark`（ネイティブの
  日付ピッカー等もダークになる）。イベントチップの文字色は背景輝度で黒/白を自動選択
  （calendar.tsx の `inkFor()` —— Google のパステル色に白文字だと読めないため）。
- ボタンは min-height 36px（タッチ端末は 42px+）で全体的に大きめ。`:focus-visible` リング付き。
- **ナビゲーション**（`app/nav.tsx`）: デスクトップは **Ubuntu 風の左アイコンドック**
  （Kロゴ＋予定表/ボード/AI/**睡眠記録**。アクティブはハイライト＋左端ピップ、ホバーでラベル表示）。
  レイアウトは `[dock | .main(topbar/content)]` の横並び。モバイルはドック非表示で
  **全ページ常設の下部タブバー**（予定表/タスク/ボード/AI/睡眠）。「戻る」ボタンは廃止。
  カレンダー内では 予定表/タスク がペイン切替、他ページからの「タスク」は `/?pane=tasks`
  （calendar.tsx が mount 時に読む）。モバイルの「＋予定」は右下の FAB。
- **アイコンは絵文字ではなく `app/icons.tsx` のインライン SVG**（feather 風の線画、
  stroke=currentColor で状態色に追従）。ナビ・FAB・ボタン類はこれを使う。
- **チャットは Slack/Discord 風**（`app/chat-pane.tsx`）: 吹き出しではなくフラットな行
  （角丸アバター＋名前＋時刻＋本文、ホバー行ハイライト）。提案カードは本文にインデントした
  「添付」スタイル。アバターは ユーザー=人物 / claude=ボット / codex=ターミナル（青）。
- レイアウトは `.app`（flex column, `100dvh`）で、topbar / body / モバイル用タブバーを縦積み。
- **≤720px**: 下部タブバー（カレンダー/タスク/＋予定/AI/記録）でペインを切替（`.body.show-tasks`）。
  タスクレールは全幅表示に、モーダルは**ボトムシート**（`.scrim{align-items:flex-end}`）になる。
  入力は 16px（iOS のフォーカスズーム防止）。`env(safe-area-inset-bottom)` 対応
  （layout.tsx で `viewportFit:"cover"`）。スマホ初回は日ビューに自動切替（calendar.tsx の mount effect）。
- タッチ端末（`pointer:coarse`）はボタン/チェックボックスの当たり判定を拡大。
- チャットモーダルは flex column 化（ログが伸び、入力欄が固定）。
- CSP: dev のみ `'unsafe-eval'` を script-src に足している（React dev モードの要求。本番は無し）。

## セキュリティ

**公開時の認証は3層**（Cloudflare Tunnel で公開する前提。素の Tunnel 直公開はしない）:
1. **Cloudflare Access**（エッジ）— Zero Trust でメール許可リスト。未認証はそもそも到達しない。
2. **オリジン側の Access 強制**（`proxy.ts`、2026-07-03 実装）— `CF_ACCESS_TEAM_DOMAIN` +
   `CF_ACCESS_AUD` を設定すると、全リクエストに有効な `Cf-Access-Jwt-Assertion`（JWKS 検証・
   iss/aud 一致）を要求し、無ければ 403。**Tunnel の経路ミスや LAN からポート直叩きでも弾ける**。
   env 未設定（dev）は完全に無効。模擬 JWKS で 403/403/200 の3ケース検証済み。
3. **アプリ自身のログイン** — Auth.js の Google ログイン＋`ALLOWED_EMAILS`。全 API ルートが
   `await auth()` でゲート済みなので、仮に上2層が破れても API は使えない。
Proxmox では `next start` を **127.0.0.1 にバインド**して cloudflared だけが届く構成を推奨
（`PORT=3000 HOSTNAME=127.0.0.1 npm run start`）。

`next.config.ts` の `headers()` で CSP / nosniff / Referrer-Policy / X-Frame-Options を全レスポンスに付与。
CSP の `frame-ancestors` は `FRAME_ANCESTORS` 環境変数で可変（ダッシュボード埋め込み用）。CSP は inline の
都合で `script-src`/`style-src` に `'unsafe-inline'` を許容している（残課題: nonce 化）。

**エージェント実行の境界（公開前に必須）:** ルートから直接 `claude -p` を spawn しているため、**公開すると
カレンダー/画像由来のプロンプトインジェクションでツール付きエージェントが暴走しうる**。現状の緩和は
(1) 抽出は `--allowedTools Read` に限定、(2) `--permission-mode default`（bypass しない）。**公開（Cloudflare）
前にやること**: `agent_jobs` を drain する**別プロセスのローカルワーカー**へ実行を移し web から spawn しない、
カレンダー書き込みは必ず人間確認、`--dangerously-skip-permissions` は絶対に使わない。

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

## ロードマップ（2026-07-02 合意。この順で進める）

1. ~~チャット→構造化アクション層~~（済 2026-07-02: proposals + 承認 UI + 汎用チャット）
2. ~~見積りフライホイール~~（済 2026-07-02: ⏱ボタン＋空き時間/較正データ注入＋実績入力 UI）
3. **承認キューの汎用化＋ローカル agentic 実行** — 提案の受信箱 UI、「diff 提案→承認で適用」。
   **ユーザー決定: エージェントが編集してよいのは Nextcloud にあるファイルのみ**（WebDAV or 同期
   ディレクトリ経由）。ユーザーは編集は OneDrive 派 → OneDrive↔Nextcloud は rclone bisync 等で
   橋渡しする案（Proxmox 側のインフラ作業、要相談）。
4. ~~かんばん~~（済 2026-07-02: `/board` ページ。`tasks.kanban` local-only 列。列移動は ‹ › ボタン
   （タッチ対応）+ デスクトップは D&D。完了列への移動は status=completed の write-through。
   モバイルは 82vw 列の横スクロール snap。update_task アクションでも kanban を動かせる）。
5. **Gmail 下書き連携** — スコープ追加＋再同意が必要。送信はせず**下書き作成まで**（承認は Gmail 側で）。

最終的に Proxmox の個人ダッシュボードへ移設予定（この環境は dev）。公開前にエージェント実行を
別プロセスワーカーへ移す（セキュリティ節を参照）。

## 次の候補（ロードマップ外・要相談）

- バックグラウンド同期（cron/Route）＋ DB 即読みでの体感速度改善。
- カレンダー/アカウント別の表示オン・オフ、ドラッグ移動・リサイズ。
- サブタスクの並べ替え・親付け替え（`tasks.move`。作成/表示/完了は実装済み、下記参照）。

## サブタスク（GitHub の sub-issue 風、2026-07-03 実装）

- **Google Tasks ネイティブの `parent`** を使う（`tasks.insert` の parent パラメータ。
  スマホの Google Tasks でもネストして見える）。階層は Google の仕様で **1段のみ** —
  `lib/actions.ts` と作成パスで「サブタスクの下にサブタスク」を拒否。
- UI: タスク編集モーダルに **サブタスクセクション**（進捗 x/y ＋バー・チェック・追加入力）。
  タスクレールは親の下にインデント表示。**かんばんはサブタスクをカード化せず**、
  親カードに進捗チップ（x/y、全完了でミント）を出す。
- エージェント: `create_task` の `parent` で分解提案ができる（「このタスクを分解して」）。
  プロンプトの未完了タスク一覧にも parent を注入済み。
