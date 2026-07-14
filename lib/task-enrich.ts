import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { tasks } from "./db/schema";
import { runAgentAuto } from "./agent";
import { createTasksBulk } from "./mutations";
import { searchKnowledge } from "./owui";

/**
 * AI一括推定: 締切あり/ASAPの未完了タスクをクロールし、RAG（授業ノート・
 * 資料・過去チャット）から関連文脈を拾って estimatedMin と priority を推定する。
 * ユーザーが手で入れた値は上書きしない（無い欄だけ埋める）。
 * 過去に完了したタスクの実績分数を較正データとして渡す。
 * 90分超の複合作業はサブタスク（Google Tasks実タスク・sub-issue）に自動分割 —
 * プランナーはサブタスク単位で空き時間に配置する。
 * 毎日0時（checkDailyEnrich）+ 朝ブリーフィング前 + 🤖ボタンから実行。
 */

const MAX_PER_RUN = 10;
const SPLIT_MIN_EST = 90; // これ以上の見積りは分割候補
const MAX_SPLITS_PER_RUN = 4;

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

interface EnrichJson {
  estimatedMin?: number;
  priority?: number;
  reason?: string;
  subtasks?: { title?: string; estimatedMin?: number }[];
}

function parseJson(text: string): EnrichJson | null {
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

// 二重実行ガード: 0時の自動・ブリーフィング前・🤖ボタンが重なると、
// サブタスク分割が競合して二重に切られる（クライアント切断後もサーバ側で
// 走り続けるので実際に起きた）。走行中は即座に空で返す。
const g = globalThis as unknown as { __kairosEnrichBusy?: boolean };

export async function enrichTasks(opts: { limit?: number; force?: boolean } = {}): Promise<EnrichResult> {
  if (g.__kairosEnrichBusy) return { examined: 0, updated: 0, lines: ["（推定は既に実行中です）"] };
  g.__kairosEnrichBusy = true;
  try {
    return await enrichTasksInner(opts);
  } finally {
    g.__kairosEnrichBusy = false;
  }
}

async function enrichTasksInner(opts: { limit?: number; force?: boolean }): Promise<EnrichResult> {
  const limit = opts.limit ?? MAX_PER_RUN;
  const all = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all();
  const childCount = new Map<string, number>();
  for (const t of all) if (t.parent) childCount.set(t.parent, (childCount.get(t.parent) ?? 0) + 1);
  const open = all
    .filter((t) => !t.parent) // サブタスクは親側の分割で扱う
    .filter(
      (t) =>
        (t.asap || t.due) &&
        (opts.force ||
          t.estimatedMin == null ||
          t.priority == null ||
          // 見積り済みでも大物が未分割なら分割候補として見る
          ((t.estimatedMin ?? 0) >= SPLIT_MIN_EST && !childCount.get(t.googleId) && t.splitNudgedAt == null)),
    )
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
    .slice(0, limit);
  const out: EnrichResult = { examined: open.length, updated: 0, lines: [] };
  if (open.length === 0) return out;

  const calib = calibrationLines();
  let splitBudget = MAX_SPLITS_PER_RUN;
  for (const t of open) {
    const q = [t.title ?? "", (t.notes ?? "").slice(0, 200)].filter(Boolean).join(" ");
    const rag = q.trim().length >= 4 ? await searchKnowledge(q, 5) : [];
    const canSplit = splitBudget > 0 && !childCount.get(t.googleId);
    const prompt = [
      "あなたは大学生の予定アシスタント。次のタスクの所要時間(分)と優先度(1-5, 5=最優先)を推定して。",
      "判断材料: 参考資料の抜粋（授業ノート・課題指示など）と、本人の過去タスクの実績分数。",
      "優先度は締切の近さ・単位や成績への影響・準備の重さで判断。レポート/課題提出は高め、軽い事務は低め。",
      canSplit
        ? "見積りが90分を超える場合は、実行順のサブタスク2〜5個（短い動詞句＋各見積り分数）に必ず分割する。分割してよいか迷ったら分割する。例外は試験を受ける・本を読み切る等、本質的に一続きの作業だけ（そのときは subtasks を省略）。"
        : "",
      `回答はJSONのみ: {"estimatedMin": <数値>, "priority": <1-5>, "reason": "<20字以内>"${canSplit ? `, "subtasks": [{"title": "<短い動詞句>", "estimatedMin": <数値>}, …]` : ""}}`,
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

    // サブタスク分割: Google Tasks の実タスク（sub-issue）として登録する。
    // プランナーはサブタスク単位で空きに置き、チェックで個別に消化できる。
    const finalEst = patch.estimatedMin ?? t.estimatedMin ?? est;
    const subs = (j.subtasks ?? [])
      .map((s) => ({ title: String(s.title ?? "").trim().slice(0, 100), est: Math.round(Number(s.estimatedMin)) }))
      .filter((s) => s.title.length >= 2);
    let splitLine = "";
    if (canSplit && subs.length >= 2 && subs.length <= 6 && (finalEst ?? 0) >= SPLIT_MIN_EST) {
      // Google Tasks の insert はリスト先頭に積む — 実行順で渡すと position が
      // 逆順になるので、逆から入れて「最初にやることが上」に揃える。
      const made = await createTasksBulk(
        subs.slice().reverse().map((s) => ({
          account: t.account,
          tasklist: t.tasklist,
          parent: t.googleId,
          title: s.title,
          estimatedMin: Number.isFinite(s.est) && s.est >= 5 && s.est <= 1000 ? s.est : null,
          priority: (patch.priority ?? t.priority) as number | null,
        })),
      ).catch((e) => {
        console.log(`[task-enrich] split failed (${t.title}): ${String(e).slice(0, 120)}`);
        return 0;
      });
      if (made > 0) {
        splitBudget--;
        splitLine = ` / サブタスク${made}件に分割`;
        patch.splitNudgedAt = Date.now(); // 「区切りませんか」ナッジと二重にならないように
      }
    }
    // 分割候補として選ばれたが分割しなかった場合も再訪しないよう印を付ける
    if (canSplit && !splitLine && (finalEst ?? 0) >= SPLIT_MIN_EST && t.estimatedMin != null && t.priority != null) {
      patch.splitNudgedAt = patch.splitNudgedAt ?? Date.now();
    }

    if (Object.keys(patch).length === 0) continue;
    db.update(tasks)
      .set(patch)
      .where(and(eq(tasks.account, t.account), eq(tasks.tasklist, t.tasklist), eq(tasks.googleId, t.googleId)))
      .run();
    out.updated++;
    out.lines.push(
      `「${t.title ?? "(無題)"}」→ ${patch.estimatedMin != null ? `見積り${patch.estimatedMin}分 ` : ""}${patch.priority != null ? `優先度${patch.priority}` : ""}${j.reason ? `（${j.reason}）` : ""}${splitLine}`,
    );
  }
  if (out.updated) console.log(`[task-enrich] ${out.updated}/${out.examined} 件を推定`);
  return out;
}
