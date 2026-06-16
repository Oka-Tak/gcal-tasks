# Calendar + Tasks

Google カレンダーと Google ToDo（Tasks）を1画面に統合する、自分専用のセルフホスト Web アプリ。
ローカル DB や同期エンジンは持たず、**Google API を直接読み書きする薄いクライアント**。表示は読み取り、
追加・編集・完了・削除はその場で Google に書き戻す（双方向）。Linux / Windows どちらからでも
ブラウザで使える。

- **月 / 週 / 日**の3ビュー切替。
- **自分の複数 Google アカウント**を接続して1画面にマージ表示（個人＋仕事など）。
- 予定の**詳細表示**（説明・場所・参加者の出欠・Meet リンク・添付・「Google で開く」）。
- Cloudflare Tunnel + Access で安全に公開できる（後述）。

---

## 1. Google Cloud 側の準備（これだけは手作業）

アプリは Google に接続するための **OAuth クライアント**を必要とする。コードでは肩代わりできない。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成。
2. 「API とサービス → ライブラリ」で次の2つを有効化：
   - **Google Calendar API**
   - **Google Tasks API**
3. 「OAuth 同意画面」：
   - User Type は **外部**。
   - スコープ追加は不要（アプリ側で要求する）。
   - **公開ステータスを「本番（公開）」にする**。テストのままだと後述の通りログインが7日で切れる。
     未審査でも、自分のアカウントで使う分には警告画面で「続行」すれば通る。
     （または公開せず、テストユーザーに自分の Gmail を追加。ただし7日失効に注意。）
4. 「認証情報 → 認証情報を作成 → OAuth クライアント ID」：
   - アプリの種類：**ウェブ アプリケーション**
   - **承認済みのリダイレクト URI** に次を追加：
     `http://localhost:8765/oauth2callback`
   - 作成後、JSON をダウンロードし、**`client_secret.json`** という名前でこのフォルダ直下に置く。

---

## 2. 起動

```bash
pip install -r requirements.txt
python main.py
```

ブラウザで `http://localhost:8765` を開き、「Google で接続」。許可するとカレンダーとタスクが出る。
（接続トークンは `tokens/<email>.json` に保存される。`chmod 600`・流出厳禁。）

> 既定の待ち受けは **`127.0.0.1`（loopback のみ）** に変更した。LAN や Tailscale から直接開くなら
> `HOST=0.0.0.0` を明示すること。公開は後述の Cloudflare Tunnel 推奨。

**複数アカウントの追加**: 右上のアカウント表示をクリック →「+ アカウントを追加」（= `/login` を再実行）。
別の Google でログインすると、そのアカウントのカレンダー/タスクもマージ表示される。切断も同じ画面から。

---

## 3. リモート（Tailscale 越し）で使う

ポイント：**初回ログインだけは localhost 経由**で行う。Google は非 localhost への http
リダイレクトを拒否するため。一度トークンを取れば、以降アプリはサーバ側で Google を叩くので、
別端末から tailnet アドレスでアクセスしても OAuth リダイレクトは発生しない。

- サーバ上で直接ログインできるなら、それで OK。
- できないなら、手元から SSH トンネルを張って localhost でログイン：
  ```bash
  ssh -L 8765:localhost:8765 user@your-server
  # 手元のブラウザで http://localhost:8765 を開いて接続
  ```
- `tokens/` ができた後は、`http://<tailnet-ip>:8765`（`HOST=0.0.0.0` 必須）などから普通に使える。

---

## 4. 公開する（Cloudflare Tunnel + Access）

> **Cloudflare Pages には載せられない。** Pages は静的＋Workers(JS) ランタイムで、FastAPI（Python 常駐
> サーバ）も `tokens/` のファイル状態も動かせない。公開したいなら、Proxmox 上でこのアプリを動かしたまま、
> **前段に Cloudflare Tunnel（公開 HTTPS）+ Cloudflare Access（認証）** を置くのが正解。コード無改修で、
> ダッシュボードの1部品として残せる。

手順の要点:

1. アプリは loopback で起動（既定の `HOST=127.0.0.1`）。`BASE_URL` を公開 URL に:
   ```bash
   BASE_URL=https://cal.example.com python main.py
   ```
2. Google Cloud の OAuth クライアントに **承認済みリダイレクト URI** を追加:
   `https://cal.example.com/oauth2callback`
3. `cloudflared` トンネルで `cal.example.com` → `http://127.0.0.1:8765` を公開。
4. Zero Trust → Access で `cal.example.com` にアプリを作成し、許可する identity（自分のメール）を設定。
5. 多層防御として、アプリ側でもメール許可リストを有効化:
   ```bash
   ALLOWED_EMAILS=you@gmail.com,you@work.com
   ```
   Access が付与する `Cf-Access-Authenticated-User-Email` ヘッダを照合する。**ポートを直接外へ晒さない**
   こと（`HOST=127.0.0.1` のまま）。晒すとヘッダ偽装でこの照合を回避できる。

これで「公開 HTTPS + 認証必須」になる。アプリ自体に来訪者ログインは無い（前段で守る設計）。

---

## 5. 知っておくべき制約

| 項目 | 内容 |
|---|---|
| トークン7日失効 | OAuth 同意画面が「テスト」状態だと refresh token が7日で失効。**本番公開**で回避。 |
| タスクは日付のみ | Google Tasks API は期限を**日付粒度のみ**（時刻不可）。2026 時点でも公式仕様。時刻が要る「やること」は Task でなく**予定（イベント）**で作る。 |
| 表示範囲 | 月/週/日の3ビュー。接続した全アカウント×全カレンダーをマージ表示。 |
| 単一「人」 | 利用者は1人想定。自分の複数 Google アカウントは接続可（来訪者ごとのセッションは無い）。 |
| 待ち受け | 既定 `127.0.0.1`。LAN/Tailscale は `HOST=0.0.0.0` を明示。 |

---

## 6. Docker（任意）

```bash
docker build -t cal-tasks .
docker run -p 8765:8765 \
  -v "$PWD/client_secret.json:/app/client_secret.json:ro" \
  -v "$PWD/tokens:/app/tokens" \
  cal-tasks
```

`tokens/` ディレクトリをマウントすると接続情報が永続化される。空のままでも、起動後に
`/login` すれば中に `<email>.json` が作られる。コンテナ内で loopback 起動なので、外から繋ぐなら
`-e HOST=0.0.0.0`（LAN）か、Tunnel を前段に置く。

---

## 構成

```
main.py             FastAPI: OAuth + Calendar/Tasks API プロキシ（マルチアカウント）
static/index.html   月/週/日カレンダー + タスクUI + 詳細モーダル（依存ライブラリなし）
client_secret.json  Google で発行（自分で配置）
tokens/<email>.json アカウントごとのトークン（初回ログインで自動生成・chmod 600）
```

## 設定（環境変数 / .env）

| 変数 | 既定 | 用途 |
|---|---|---|
| `PORT` | 8765 | 待ち受けポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス。LAN/Tailscale は `0.0.0.0` |
| `BASE_URL` | http://localhost:8765 | OAuth コールバックの基底 URL（Tunnel 越しは公開 https） |
| `CLIENT_SECRETS` | ./client_secret.json | クライアント機密のパス |
| `TOKENS_DIR` | ./tokens | アカウントごとトークンの保存先 |
| `TOKEN_PATH` | ./token.json | 旧・単一トークンの移行元（初回のみ参照） |
| `ALLOWED_EMAILS` | （空＝無効） | Cloudflare Access の identity 許可リスト |
| `FRAME_ANCESTORS` | `'self'` | iframe 埋め込み許可元（ダッシュボード用） |
