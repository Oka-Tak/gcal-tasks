# Kairos

Google カレンダーと Google ToDo（Tasks）を1画面に統合する、自分専用のセルフホスト Web アプリ。
Next.js 16（App Router / TypeScript）+ SQLite（Drizzle）+ Auth.js。

旧版（FastAPI の薄い API ブリッジ）からの作り直し。最大の違いは **ローカル DB（SQLite）を持つ**こと。
Google を「真実の源」とする同期ミラーを保持し、その上に **Google が保存できない情報**（とくに
**タスクの時刻**）をローカル専用カラムとして足す。DB は素直なスキーマなので、Proxmox 上の別ツール
（Claude Code など）から直接読める。

- **月 / 週 / 日**の3ビュー。
- **自分の複数 Google アカウント**を接続して1画面にマージ。
- 予定の**詳細表示**（説明・場所・参加者の出欠・Meet・添付・「Google で開く」）。
- **タスクに時刻**を付けられる（Kairos 内のみ。Google Tasks API は日付しか持てない）。
- Auth.js による堅いログイン＋セッション、トークンは**暗号化して保存**。

---

## 1. Google Cloud 側の準備

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成。
2. 「API とサービス → ライブラリ」で **Google Calendar API** と **Google Tasks API** を有効化。
3. 「OAuth 同意画面」：User Type は外部。常用するなら**本番（公開）**に（テストのままだと7日で失効）。
4. 「認証情報 → OAuth クライアント ID」：種類は **ウェブ アプリケーション**。**承認済みリダイレクト URI** に
   次の2つを追加（`AUTH_URL` を基準に）：
   - `http://localhost:3000/api/auth/callback/google` — アプリのログイン
   - `http://localhost:3000/api/connect/callback` — 追加アカウントの接続
     公開時はここを公開 https URL に差し替え／追加する。
5. クライアント ID とシークレットを `.env.local` の `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` に。

## 2. 起動（開発）

```bash
cp .env.example .env.local      # 値を埋める（AUTH_SECRET, KAIROS_ENC_KEY は openssl rand -base64 32）
npm install
npm run dev                     # http://localhost:3000
```

「Google で接続」でログイン。許可するとカレンダーとタスクが出る。スキーマのマイグレーションは
**起動時に自動適用**される（`drizzle/` の SQL）。スキーマを変えたら `npm run db:generate`。

**複数アカウント**: 右上のアカウント表示 →「+ アカウントを追加」で別の Google を接続。切断も同じ場所。

## 3. 公開する（現在の本番: Tailscale Serve）

> Cloudflare **Pages には載らない**（Next.js の常駐サーバ＋SQLite ファイルは Workers では動かない）。
> 現在はProxmox上のsystemdサービスをTailscale Serveでtailnet内だけに公開する。

1. `npm run build && npm run start -- -H 127.0.0.1 -p 3000` でloopbackだけに待ち受ける。
2. Tailscale Serveから `http://127.0.0.1:3000` へ転送する。インターネット公開は有効にしない。
3. `AUTH_URL` をTailscale ServeのHTTPS URLにする。GoogleのリダイレクトURIも同URLで登録する。
4. `ALLOWED_EMAILS` でAuth.jsのログインを許可リストに制限する。

`proxy.ts` のCloudflare Access検証は過去の構成との互換用であり、関連環境変数が未設定でもTailscale本番を遮断しない。

## 4. 知っておくべき制約

| 項目            | 内容                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| タスクの時刻    | **Kairos の DB のみ**で保持。Google Tasks API は日付粒度しか持てないので、スマホの Google 側には出ない。スマホにも出したい時刻付きの用事は「予定」で作る。 |
| 同期方針        | Google が真実の源。fetch ごとに DB を upsert し、消えた物はソフト削除。ローカル専用カラム（時刻等）は保持。                                                      |
| トークン7日失効 | OAuth 同意画面が「テスト」だと refresh token が7日で失効。**本番公開**で回避。                                                                             |
| 単一「人」      | 利用者は1人想定。自分の複数 Google アカウントは接続可。来訪者ごとのセッションは無い（前段で守る）。                                                              |

## 5. Docker（任意）

```bash
docker build -t kairos .
docker run -p 3000:3000 --env-file .env.local \
  -e KAIROS_DB=/data/kairos.db -v kairos-data:/data \
  kairos
```

SQLite は `-v` で外出しして永続化する。

## 構成

```
app/                  App Router（page=カレンダーUI / api/*=Route Handlers）
app/calendar.tsx      フロント本体（月/週/日・詳細・タスク時刻）。単一クライアントコンポーネント
auth.ts               Auth.js（Google ログイン + ALLOWED_EMAILS ゲート）
lib/db/               Drizzle スキーマ + 遅延初期化クライアント
lib/google.ts         アカウント別 OAuth2 クライアント（自動リフレッシュ→再暗号化保存）
lib/sync.ts           ミラー同期（fetch→upsert、ローカル専用カラム保持）
lib/crypto.ts         トークン暗号化（AES-256-GCM）
drizzle/              生成済みマイグレーション（起動時に自動適用）
```

設計の詳細・落とし穴は `CONTEXT.md`、2026-07-14時点のコード監査結果と改善計画は
`AUDIT.md` を参照。環境変数は `.env.example` を参照。
