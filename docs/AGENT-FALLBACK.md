# エージェント・フォールバック基盤

Kairos / mnemo の AI 機能を特定ベンダーに依存させないための仕組み。
claude が limit に達したとき・CLI が壊れたとき・将来 他社 LLM やローカル LLM に
移行するときに、**優先順位の設定を変えるだけで全機能が追随する**ことを目標とする。

- 実装: `lib/agent.ts`（runAgentAuto / probeAgent）、`lib/agent-priority.ts`、`lib/vision.ts`
- 設定: `data/agent-priority.json`（UI からも編集可）
- mnemo 側: `mnemo/lib/agent.ts` の runAgentAuto が同じ設定ファイルを共有

## 1. 優先順位（設定）

`data/agent-priority.json`:

```json
{
 "order": [
  { "agent": "claude" },
  { "agent": "codex",   "model": "gpt-5.4-mini",     "effort": "medium" },
  { "agent": "copilot", "model": "auto" },
  { "agent": "agy",     "model": "Gemini 3.5 Flash", "effort": "Medium" }
 ],
 "probe": true
}
```

- `order` の並び = 試す順。先頭が最優先。
- `claude` 段の model/effort は省略時、呼び出し側の指定（ジョブごとの希望モデル）を引き継ぐ。
  他エージェントは `order` に書いた model/effort を使う（未指定なら呼び出し側→CLI既定）。
- 編集方法（どれでも）:
  - **UI**: カレンダー右上のアカウントモーダル →「バックグラウンドAIの優先順位」
  - **API**: `PUT /api/agents` `{"order": ["codex","claude"], "probe": true}`
  - **直接**: このファイルを編集（30秒以内に反映）
- mnemo（OWUIチャットの人物収穫・ブリッジ）も同じファイルを読む（読めなければ内蔵既定）。

## 2. 実行フロー（runAgentAuto）

バックグラウンドAIジョブはすべて `runAgentAuto(prompt, opts)` を通る。

```
for each step in priority.order:
  1. claude 段のみ: 5h枠の残りが KAIROS_CLAUDE_MIN_PCT（既定15%）未満ならスキップ
     （lib/quota.ts が OAuth usage API で全アカウントの残量を見る。claude-pool が
      複数アカウントの最良を選ぶので、②アカウントに残があればそちらで実行される）
  2. probe=true のとき: そのエージェントの最安モデルに「1+1」を投げて生存確認
     - 成功キャッシュ10分 / 失敗キャッシュ3分（実ジョブの成否でも上書き）
     - limit・認証切れ・CLI故障を数秒で検知して次の段へ
  3. 実行。失敗（エラー/タイムアウト/空応答）なら次の段へ
全滅なら ok:false（各機能は「文字起こしだけ残す」等の劣化動作へ）
```

プローブの最安モデル: claude=haiku(low) / codex=gpt-5.4-mini(low) / copilot=auto / agy=Gemini 3.5 Flash(Low)。
`probe:false` にすると従来どおり「実行して失敗したら次」のみ。

## 3. 画像入力のフォールバック（runVisionAuto）

CLI で Vision が使えるのは claude だけなので、画像系は専用の2段構え:

```
1. claude が order に居て健全（枠あり+プローブOK） → Read で画像を直読み
2. だめなら ローカルOCR（PaddleOCR 常駐 :9997、無料・外部送信なし）でテキスト化し、
   そのテキストを通常のフォールバック連鎖に投げる
```

- OCRサーバ: mnemo の `owui-ocr.service`（`KAIROS_OCR_URL` で変更可）。
- 対象機能: レシート/決済スクショ取り込み（lib/money.ts）、睡眠スクショ取り込み（lib/logs.ts）。
- OCR経路は精度が落ちる（グラフ・レイアウトは読めない）が、金額・日時などのテキストは拾える。

## 4. 機能 → 経路の対応表

| 機能 | 入口 | 経路 |
| --- | --- | --- |
| ノート要約（音声/フォルダ/再要約） | lib/notes.ts summarizeAndPublish | runAgentAuto |
| 授業総まとめ（テスト対策） | lib/course-note.ts | runAgentAuto |
| タスクAI推定・サブタスク分割 | lib/task-enrich.ts | runAgentAuto（haiku low 指定） |
| 朝ブリーフィングの一言 | lib/briefing.ts | runAgentAuto（haiku low） |
| 学情課題の取り込み | lib/gakujo-import.ts | runAgentAuto |
| レシート/決済スクショ | lib/money.ts | **runVisionAuto**（claude→OCR+連鎖） |
| 睡眠スクショ | lib/logs.ts | **runVisionAuto** |
| mnemo 人物収穫/マージ/エンリッチ | mnemo/lib/people.ts | runAgentAuto（共有priority） |
| mnemo グラス音声(voice) | bridge/server.ts | runAgentAuto + **専用高速連鎖**（明示chainはprobe無し） |
| **対話チャット（Kairos AIタブ / OWUI）** | lib/chat.ts / bridge | **対象外** — ユーザーのモデル選択を尊重（失敗はエラー表示） |
| 名刺OCR | mnemo/lib/people.ts | 最初からローカルOCR（LLM不使用） |

## 5. 新しいエージェント（他社LLM・ローカルLLM）の足し方

前提: **stdin にプロンプト、stdout に応答を返す CLI** があれば繋がる。

1. `lib/agents-catalog.ts` の `AGENT_CATALOG` にエージェント名とモデル一覧を追加
   （`AgentName` 型にも名前を追加）。
2. `lib/agent.ts` の spawn 分岐に CLI 呼び出しを追加（既存の agy の実装が最小例。
   引数は argv 配列で渡す — シェル文字列は使わない）。`lib/agent-env.ts` の
   許可リストに必要な環境変数（認証ディレクトリ等）を足す。
3. `PROBE_MODELS` に最安モデルを追加。
4. `data/agent-priority.json` の order に足す（UIからも可）。
5. mnemo にも同じ変更をコピー（lib/agent.ts, lib/agents-catalog.ts）。

ローカルLLMの例: `ollama run <model>` は stdin/stdout で動くのでそのまま 2. の形に
はまる（`{ agent: "ollama", model: "qwen3:14b" }` を order の最後に置けば
「全クラウドが死んでも動く」最終段になる）。llama.cpp は `llama-cli -p` 系を薄い
ラッパースクリプトで stdin/stdout 化するのが楽。

## 6. 運用メモ

- claude の枠しきい値: `KAIROS_CLAUDE_MIN_PCT`（既定15。mnemo は `MNEMO_CLAUDE_MIN_PCT`）。
- claude 複数アカウント: `KAIROS_CLAUDE_DIRS`（claude-pool が残量最大を選ぶ）。
- 失敗の見え方: agent_jobs テーブル（kind=probe 含む）と journalctl の
  `[agent-auto]` / `[agent-probe]` / `[vision]` 行。
- フォールバック先の出力癖: codex/copilot は「ファイルに保存しようとする」等の
  メタ発言が混ざることがある → 要約系プロンプトには「ツール不使用・本文のみ」を
  明記済み。新しいジョブを足すときも同じ注意書きを入れること。
- 意図的に direct-write（承認フロー無し）なのは AUDIT.md §11 を参照。
