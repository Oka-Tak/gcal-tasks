# CONTEXT — gcal-tasks 引き継ぎ

このリポジトリを Claude Code が引き継ぐための現状メモ。実装済みの設計判断と、変更時に踏みやすい
地雷を先に共有する。新機能を足す前にこのファイルを読むこと。

## 目的

Google カレンダーと Google Tasks を1画面に統合する、**個人専用・セルフホストの Web アプリ**。
Linux / Windows どちらからでもブラウザで使う。Morgen の有料機能を避け、無料で全機能を得るのが動機。

## 設計判断（守るべき前提）

- **ローカル DB / 同期エンジンを持たない。** Google API を直接読み書きする薄いクライアント。
  読み取りは毎回 Google を叩き、追加・編集・完了・削除はその場で書き戻す。
  → 同期競合・差分管理の複雑さを意図的に排除している。DB を導入する変更は、この方針を覆すので
    やるなら明示的に相談する事項。マルチアカウント化（下記）も DB ではなく**トークンを複数ファイルで
    持つ**形にして、この方針を守っている。
- **単一「人」前提・複数アカウント可。** アプリ利用者は1人（あなた）。ただし自分の複数 Google
  アカウント（個人＋仕事など）を接続して1画面にマージできる。トークンは `tokens/<email>.json`
  に1アカウント1ファイルで保存（`{"email":..,"token":<creds>}` のラッパ）。**来訪者ごとのセッションは
  無い** ── アクセス制御は前段（Cloudflare Access / Tailscale）に任せ、`ALLOWED_EMAILS` で二重化する。
  旧 `token.json` は初回起動時に `tokens/` へ自動移行し、元ファイルは `.bak` にリネームされる。
- **読み取りは全アカウント×全カレンダーをループしてマージ。** 各 event/task/calendar に `account`
  （所有アカウントのメール）が付く。書き込み（POST/PATCH/DELETE）は `account` を必須引数にして
  所有アカウントの service へルーティングする。ここを落とすと別アカウントへ書こうとして失敗する。
- **OAuth はループバック（localhost）http、または Tunnel 越し https で完結。** 非 localhost への
  **http** リダイレクトは Google が拒否する。Cloudflare Tunnel を前段に置く場合は `BASE_URL` を
  公開 https URL にし、`<BASE_URL>/oauth2callback` を承認済みリダイレクト URI に追加する。
- **PKCE の code_verifier を `/login`→`/oauth2callback` 間で `_pending_verifiers` に保持。**
  Flow が別インスタンスになるため。ここを消すと `invalid_grant: Missing code verifier` で落ちる。
  併せて callback では `state` を発行済みのものと照合（CSRF 対策）。未知/失効 state は 400。
- 環境変数 `OAUTHLIB_RELAX_TOKEN_SCOPE=1` は常時 `setdefault`（スコープ順の揺れ対策）。
  `OAUTHLIB_INSECURE_TRANSPORT=1` は **`BASE_URL` が http の時だけ** 設定する（https では付けない）。
- **セキュリティ層（公開前提）。** 全レスポンスに CSP / nosniff / Referrer-Policy を付与する
  ミドルウェアあり。CSP の `frame-ancestors` は `FRAME_ANCESTORS` で可変（将来の Proxmox
  ダッシュボード埋め込み用）。`HOST` の既定は **`127.0.0.1`**（loopback）。LAN/Tailscale は
  `HOST=0.0.0.0` を明示。トークンファイルは `chmod 600`・`tokens/` は `700`。

## 技術スタック

- バックエンド: FastAPI + uvicorn（`main.py`）
- Google: `google-auth` / `google-auth-oauthlib` / `google-api-python-client`
- フロント: 単一 HTML（`static/index.html`）。ビルド工程なし・外部ライブラリ依存なしの素の JS。
- Python 3.10 で動作確認済み（開発環境は 3.12）。

## ファイル構成

```
main.py             FastAPI: OAuth + Calendar/Tasks API プロキシ（マルチアカウント）
static/index.html   月/週/日カレンダー + タスクUI + 詳細モーダル（依存なし）
requirements.txt
Dockerfile / .env.example / .gitignore
README.md           セットアップ手順
client_secret.json  Google 発行（gitignore 済み・コミット禁止）
tokens/<email>.json アカウントごとのトークン（gitignore 済み・コミット禁止）
```

## API エンドポイント（main.py）

書き込み系は `account`（所有アカウントのメール）必須。POST/PATCH は body に、DELETE は query に入れる。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/login` | OAuth 開始（再実行で別アカウントを追加接続） |
| GET | `/oauth2callback` | state 照合→トークン交換→`tokens/<email>.json` 保存 |
| GET | `/api/status` | 認証状態 + 接続アカウント一覧（色付き） |
| GET | `/api/accounts` | 接続アカウント一覧 |
| DELETE | `/api/accounts/{email}` | アカウント切断（トークン削除） |
| GET | `/api/calendars` | 全アカウントのカレンダー一覧（`account`・色付き） |
| GET | `/api/events?timeMin&timeMax` | 全アカウント×全カレンダーをマージした予定 |
| POST | `/api/events` | 予定作成（body: account, calendarId） |
| PATCH | `/api/events/{calendarId}/{eventId}` | 予定更新（body: account） |
| DELETE | `/api/events/{calendarId}/{eventId}?account` | 予定削除 |
| GET | `/api/tasklists` | 全アカウントのタスクリスト一覧（`account`） |
| GET | `/api/tasks?account&tasklist` | タスク一覧（`parent` 付き＝サブタスク） |
| POST | `/api/tasks` | タスク作成（body: account, tasklist） |
| PATCH | `/api/tasks/{tasklist}/{taskId}` | タスク更新（body: account・完了切替含む） |
| DELETE | `/api/tasks/{tasklist}/{taskId}?account` | タスク削除 |

イベントは詳細表示用に読み取り専用フィールドも返す: `attendees`（応答状況付き）, `meet`,
`attachments`, `organizer`, `htmlLink`, `recurring`。
スコープ: `calendar`, `tasks`, `openid`, `userinfo.email`。

## 既知の制約・落とし穴

- **Google Tasks の期限は日付のみ**（API が時刻を持てない）。2026-06 に公式 REST リファレンスで
  再確認済み: "the time portion of the timestamp is discarded … It isn't possible to read or write
  the time that a task is due via the API."。Tasks アプリ/カレンダー UI 上は時刻付きにできるが、
  公開 API v1 はそれを露出しない。**時刻が要る「やること」は Task ではなく Calendar イベントで作る**のが
  現実解。フロントの期限入力にもこの旨を明記済み。
- **OAuth「テスト」状態だと refresh token が7日で失効。** 常用するなら同意画面を「本番（公開）」に。
  未審査でも本人アカウントは警告画面の「続行」で通る。
- `/api/events` は **全アカウント × 全カレンダー** をループして取得するので、アカウント/カレンダー数に
  比例して API 呼び出しが増える。さらに `list_accounts()` がリクエスト毎にトークンを読み（必要なら
  refresh して再保存）走る。個人用途では許容範囲。重くなったら calendarList とサービスのキャッシュ余地あり。
- イベント PATCH のパスは `{calendar_id:path}` で greedy マッチ。calendar id に `@` は入るが
  スラッシュは通常入らない前提。`account` はパスに入れず body/query に分離した（greedy マッチとの衝突回避）。
- 期限切れ/取り消し済みトークンのアカウントは `list_accounts()` で握りつぶしてスキップする。
  全体を 500 にしないため。切れているアカウントは UI に出ない＝再ログインが必要。

## 起動

```bash
pip install -r requirements.txt
python main.py            # http://localhost:8765
```

Google Cloud 側の準備（API 有効化・OAuth クライアント作成・client_secret.json 配置）は README 参照。
現状、開発者は API 有効化と本番公開・初回ログインまで完了済みの想定。

## 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 8765 | ポート |
| `HOST` | **127.0.0.1** | 待ち受け。LAN/Tailscale は `0.0.0.0` を明示（旧既定から変更） |
| `BASE_URL` | http://localhost:8765 | OAuth コールバック基底 URL。Tunnel 越しは公開 https |
| `CLIENT_SECRETS` | client_secret.json | クライアント機密パス |
| `TOKENS_DIR` | tokens | アカウントごとトークンの保存ディレクトリ |
| `TOKEN_PATH` | token.json | 旧・単一トークンの移行元（初回のみ参照） |
| `ALLOWED_EMAILS` | （空＝無効） | 設定時、Cloudflare Access の identity ヘッダがこの一覧に無いと 403 |
| `FRAME_ANCESTORS` | `'self'` | CSP の iframe 埋め込み許可元（ダッシュボード埋め込み用） |

## 公開（Cloudflare Tunnel + Access）

採用方針: **Cloudflare Pages へは載せない**（FastAPI 常駐＋ファイル状態は Workers で動かない）。
Proxmox 上で本アプリを `127.0.0.1` で動かし、`cloudflared` トンネルで公開 https を張り、
Cloudflare Access（Zero Trust）で前段認証する。これでコード無改修・公開 HTTPS・認証付きになり、
#6 のダッシュボードの1コンポーネントとして残せる。多層防御として `ALLOWED_EMAILS` を併用し、
ポートを直接外に晒さない（`HOST=127.0.0.1`）ことでヘッダ偽装を防ぐ。README の「公開」節参照。

## 次の候補（未着手・優先度は要相談）

- ドラッグで予定を移動・リサイズ（現状はモーダル編集のみ）
- カレンダーごとの表示オン/オフ・絞り込み（アカウント別フィルタも）
- タスクの並べ替え（ドラッグ）／サブタスクの作成（現状は表示のみ）
- Cloudflare Access の JWT（`Cf-Access-Jwt-Assertion`）検証への格上げ（現状はメールヘッダ照合）
- 別プロジェクト（Proxmox 上の個人統合アシスタント）への組み込み: `/api/*` は account 付きで
  再利用しやすい形になった。埋め込みは `FRAME_ANCESTORS` をダッシュボード origin に設定。

## 作業の進め方（開発者の好み）

- 過剰な修飾は不要。対等な批評を優先し、最善解を出す。
- 情報が足りないときは推論で埋めず、不足点を端的に挙げて質問する。
- 数式・アルゴリズムは大道具を避け簡単な処理を好む。技巧的な箇所は途中を明記。
