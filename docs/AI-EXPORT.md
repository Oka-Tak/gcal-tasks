# AIエクスポート取り込み（Claude / ChatGPT のチャット履歴 → RAG）

Claude.ai と ChatGPT のチャット履歴を、このマシンのローカル RAG に取り込む仕組み。
取り込むと、mnemo（:443 チャット / グラス）・OWUI・Claude Code の全部から過去の会話を
横断検索・参照できるようになる。**手順は「エクスポートzipを所定フォルダに置くだけ」**。

## 使い方（あなたがやること）

1. **各サービスでエクスポートを申請する**
   - **Claude**: claude.ai → Settings → Privacy →「Export data」。数分〜数十分後にメールで
     ダウンロードリンクが届く（`conversations.json` と `projects/*.json` を含む zip）。
   - **ChatGPT**: ChatGPT → Settings → Data controls →「Export data」。同じくメールで zip が届く
     （`conversations.json` を含む）。
2. **届いた zip を、置き場フォルダにそのまま置く**（解凍しない）
   - 置き場: `~/onedrive-sync/zdk7v-hfcmy/AIエクスポート/`
   - **Windows からでOK**: OneDrive の同名フォルダ `AIエクスポート/` に入れれば、Syncthing 経由で
     このマシンに同期される。ファイル名は何でもよい（`.zip` であればよい）。
3. **あとは自動**。30分ごとのタイマーが検出して取り込み、完了すると ntfy で通知が来る
   （📥 Claude/ChatGPT エクスポート取り込み完了）。

> 急ぎで反映したいときは端末で: `systemctl --user start ai-export-watch.service`

## 何が起きるか（取り込みの中身）

`scripts/ai-export-watch.ts`（`ai-export-watch.timer`、30分）が置き場を監視し、zip を展開して
`conversations.json` の中身で種類を自動判定（`"mapping"`→ChatGPT / `"chat_messages"`→Claude）、
対応するインポータを回す。インポータは **snapshot 方式で冪等** ― 再エクスポートして置き直しても、
新規・更新された会話だけを push する。

| 元 | インポータ | ローカル出力 | OWUI 取り込み先 |
| --- | --- | --- | --- |
| Claude 会話 | `import-claude-web.ts` | `~/claude-web-export/conversations/*.md` | Knowledge「Claude Web履歴」（RAG） |
| Claude 会話（閲覧用） | `import-claude-web-chats.ts` | ― | サイドバーのチャット「Claude Web履歴」フォルダ（claude.ai風に読める） |
| Claude プロジェクト | `import-claude-web.ts` | `~/claude-web-export/projects/<名>/` | Knowledge「Claude PJ: <名>」（PJごとに分離） |
| ChatGPT 会話 | `import-chatgpt.ts` | `~/chatgpt-export/conversations/*.md` | Knowledge「ChatGPT履歴」（RAG） |

- ローカルの `.md` は **Claude Code からも grep 可能**（`~/claude-web-export/`, `~/chatgpt-export/`）。
- ChatGPT の会話ツリーは `current_node` から親を遡って**本流だけ**を線形化して保存する。

## 設定・状態・場所

| 項目 | 値 |
| --- | --- |
| 置き場（上書き可） | `KAIROS_AI_EXPORT_DIR`（既定 `~/onedrive-sync/zdk7v-hfcmy/AIエクスポート/`） |
| タイマー | `ai-export-watch.timer`（30分ごと。`ops/` で版管理） |
| 取り込み状態 | `~/.local/state/ai-export-watch.json`（zip名→mtime/size/結果） |
| 各インポータの冪等状態 | `~/.local/state/{chatgpt-import,claude-web-chats}.json` ほか |
| 転送中ガード | zip の mtime が 2分以内なら掴まない（Syncthing 転送途中を避ける） |
| 完了通知 | `.env.local` の `KAIROS_NTFY_*`（未設定なら黙る） |

## 確認・トラブルシュート

```bash
# 直近の取り込みログ
journalctl --user -u ai-export-watch.service -n 50 --no-pager
# いま置いてある zip と取り込み状態
ls -la ~/onedrive-sync/zdk7v-hfcmy/AIエクスポート/
cat ~/.local/state/ai-export-watch.json
# 手動で即実行
systemctl --user start ai-export-watch.service
```

- **「conversations.json が見つからない / 形式を判定できない」**: zip がエクスポート本体でない
  （画像だけ等）可能性。Claude/ChatGPT の「データエクスポート」で出た zip か確認。
- **取り込まれない**: ①まだ 2分の settle 中、②30分タイマー待ち（`start` で即実行）、
  ③同じ zip を既取り込み（state に記録済み。中身が変わっていれば mtime/size 変化で再取り込み）。
- **やり直したい**: `~/.local/state/ai-export-watch.json` から該当 zip の行を消して再実行。
- OWUI が満杯・不調で push に失敗したときは state に記録されず、次回リトライされる。

## 関連

- フォールバック（Claude→他LLM/ローカル）: [AGENT-FALLBACK.md](./AGENT-FALLBACK.md)
- 用語集（AIに誤解させない固有名詞）: mnemo の UI（:8443）で編集、`kairos.db` の glossary テーブル
  （`lib/glossary.ts`）。`lib/kairos.ts` が全AI会話に注入する。
- 取り込んだ履歴は mnemo の人物メモ抽出・RAG の材料になる（bridge/rag.ts, lib/kairos.ts）。
