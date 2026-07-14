import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { tasks } from "./db/schema";
import { runAgentAuto } from "./agent";
import { searchKnowledge } from "./owui";

/**
 * AI一括推定: 締切あり/ASAPの未完了タスクをクロールし、RAG（授業ノート・
 * 資料・過去チャット）から関連文脈を拾って estimatedMin と priority を推定する。
 * ユーザーが手で入れた値は上書きしない（無い欄だけ埋める）。
 * 過去に完了したタスクの実績分数を較正データとして渡す。
 * 毎朝ブリーフィング前に1回 + プランカードの手動ボタンから実行。
 */

const MAX_PER_RUN = 10;

type TaskRow = typeof tasks.$inferSelect;

function calibrationLines(): string[] {
  const done = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "completed")))
    .all()
    .filter((t) => t.actualMin != null)
    .slice(-20);
  return done.map((t) => `- 「${t.title ?? ""}」実績${t.actualMin}分${t.estimatedMin ? `（見積り${t.estimatedMin}分）` : ""}`);
}

function parseJson(text: string): { estimatedMin?: number; priority?: number; reason?: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export interface EnrichResult {
  examined: number;
  updated: number;
  lines: string[]; // UI表示用「タスク → 見積り/優先度 (理由)」
}

export async function enrichTasks(opts: { limit?: number; force?: boolean } = {}): Promise<EnrichResult> {
  const limit = opts.limit ?? MAX_PER_RUN;
  const open = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all()
    .filter((t) => (t.asap || t.due) && (opts.force || t.estimatedMin == null || t.priority == null))
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
    .slice(0, limit);
  const out: EnrichResult = { examined: open.length, updated: 0, lines: [] };
  if (open.length === 0) return out;

  const calib = calibrationLines();
  for (const t of open) {
    const q = [t.title ?? "", (t.notes ?? "").slice(0, 200)].filter(Boolean).join(" ");
    const rag = q.trim().length >= 4 ? await searchKnowledge(q, 5) : [];
    const prompt = [
      "あなたは大学生の予定アシスタント。次のタスクの所要時間(分)と優先度(1-5, 5=最優先)を推定して。",
      "判断材料: 参考資料の抜粋（授業ノート・課題指示など）と、本人の過去タスクの実績分数。",
      "優先度は締切の近さ・単位や成績への影響・準備の重さで判断。レポート/課題提出は高め、軽い事務は低め。",
      `回答はJSONのみ: {"estimatedMin": <数値>, "priority": <1-5>, "reason": "<20字以内>"}`,
      "",
      `# タスク: ${t.title ?? "(無題)"}`,
      t.notes ? `# メモ: ${t.notes.slice(0, 500)}` : "",
      t.due ? `# 期限: ${t.due.slice(0, 10)}${t.dueTime ? ` ${t.dueTime}` : ""}` : "# 期限: ASAP",
      t.estimatedMin != null ? `# 既存の見積り: ${t.estimatedMin}分（変更不要ならこの値を返す）` : "",
      "",
      ...(rag.length ? ["# 参考資料（RAG抜粋）", ...rag.map((r) => `--- ${r.src} ---\n${r.text}`)] : []),
      ...(calib.length ? ["", "# 本人の過去実績（較正用）", ...calib] : []),
    ].filter(Boolean).join("\n");

    const res = await runAgentAuto(prompt, { model: "haiku", effort: "low", jobKind: "task-enrich", timeoutMs: 120_000 });
    if (!res.ok) {
      console.log(`[task-enrich] agent failed (${t.title}): ${String(res.error).slice(0, 100)}`);
      continue;
    }
    const j = parseJson(res.text);
    if (!j) continue;
    const patch: Partial<typeof tasks.$inferInsert> = {};
    const est = Math.round(Number(j.estimatedMin));
    const pri = Math.round(Number(j.priority));
    if ((opts.force || t.estimatedMin == null) && Number.isFinite(est) && est >= 5 && est <= 3000) patch.estimatedMin = est;
    if ((opts.force || t.priority == null) && Number.isFinite(pri) && pri >= 1 && pri <= 5) patch.priority = pri;
    if (Object.keys(patch).length === 0) continue;
    db.update(tasks)
      .set(patch)
      .where(and(eq(tasks.account, t.account), eq(tasks.tasklist, t.tasklist), eq(tasks.googleId, t.googleId)))
      .run();
    out.updated++;
    out.lines.push(
      `「${t.title ?? "(無題)"}」→ ${patch.estimatedMin != null ? `見積り${patch.estimatedMin}分 ` : ""}${patch.priority != null ? `優先度${patch.priority}` : ""}${j.reason ? `（${j.reason}）` : ""}`,
    );
  }
  if (out.updated) console.log(`[task-enrich] ${out.updated}/${out.examined} 件を推定`);
  return out;
}
