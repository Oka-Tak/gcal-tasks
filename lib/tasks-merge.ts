import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { tasks } from "./db/schema";
import { tasksFor } from "./google";
import { syncTasks } from "./sync";
import { taskIdentity } from "./task-identity";

/**
 * 重複タスクのマージ。学情の課題が「一覧取り込み(📅)」と「詳細取り込み(📚)/
 * AI推定」で別タスクになるなど、同じ課題が複数タスクに割れることがある。
 * 情報の多い1件に寄せ、他方のサブタスク・メモ・見積り・gakujoマーカーを
 * 引き継いでから残りを削除する。
 */

type Row = typeof tasks.$inferSelect;

const normTitle = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 情報量スコア（サブタスク数 > メモ > 見積り/優先度 > 期限時刻）。keep自動選定用。 */
function richness(t: Row, childCount: number): number {
  return childCount * 100 + (t.notes ? 20 : 0) + (t.estimatedMin ? 5 : 0) + (t.priority ? 5 : 0) + (t.dueTime ? 2 : 0);
}

export interface DuplicateGroup {
  key: string; // 正規化タイトル
  title: string; // 代表タイトル（keep候補）
  tasks: { key: string; title: string; due: string | null; subCount: number; hasNotes: boolean; est: number | null; suggestedKeep: boolean }[];
}

/** 未完了・親タスクの中から、正規化タイトルが一致する重複グループを返す。 */
export function findDuplicateTasks(): DuplicateGroup[] {
  const all = db.select().from(tasks).where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction"))).all();
  const childCount = new Map<string, number>();
  for (const t of all) if (t.parent) childCount.set(t.parent, (childCount.get(t.parent) ?? 0) + 1);
  const parents = all.filter((t) => !t.parent);

  const groups = new Map<string, Row[]>();
  for (const t of parents) {
    const k = normTitle(t.title);
    if (!k) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: DuplicateGroup[] = [];
  for (const [k, rows] of groups) {
    if (rows.length < 2) continue;
    const scored = rows.map((t) => ({ t, score: richness(t, childCount.get(t.googleId) ?? 0) }));
    const keep = scored.slice().sort((a, b) => b.score - a.score)[0].t;
    out.push({
      key: k,
      title: keep.title ?? "(無題)",
      tasks: rows.map((t) => ({
        key: taskIdentity(t),
        title: t.title ?? "(無題)",
        due: t.due?.slice(0, 10) ?? null,
        subCount: childCount.get(t.googleId) ?? 0,
        hasNotes: !!t.notes,
        est: t.estimatedMin ?? null,
        suggestedKeep: t.googleId === keep.googleId,
      })),
    });
  }
  return out;
}

function rowByKey(key: string): Row | null {
  const [account, tasklist, googleId] = key.split("|");
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.account, account), eq(tasks.tasklist, tasklist), eq(tasks.googleId, googleId)))
    .get() ?? null;
}

/** gakujoマーカー [gakujo:xxxx] を全部集める（重複判定を今後も効かせるため）。 */
function gakujoMarkers(...notes: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const n of notes) for (const m of (n ?? "").matchAll(/\[gakujo:[0-9a-f]+\]/g)) set.add(m[0]);
  return [...set];
}

/**
 * keepKey に dropKeys をマージする。drop側のサブタスクを keep 配下へ移動し、
 * keep が空の欄（メモ・見積り・優先度・期限時刻）を drop から補完、gakujo
 * マーカーを keep のメモへ集約してから drop を削除する。同一 tasklist 前提。
 */
export async function mergeTasks(keepKey: string, dropKeys: string[]): Promise<{ merged: number; movedSubtasks: number }> {
  const keep = rowByKey(keepKey);
  if (!keep || keep.deletedAt) throw new Error("残すタスクが見つかりません");
  const drops = dropKeys.map(rowByKey).filter((r): r is Row => !!r && !r.deletedAt && r.googleId !== keep.googleId);
  if (drops.length === 0) throw new Error("統合するタスクがありません");
  if (drops.some((d) => d.account !== keep.account)) throw new Error("別アカウントのタスクは統合できません");

  const api = tasksFor(keep.account);
  let movedSubtasks = 0;

  // 1) drop のサブタスクを keep 配下へ移動（Google Tasks は同一リスト内のみ）
  for (const d of drops) {
    const kids = db
      .select()
      .from(tasks)
      .where(and(isNull(tasks.deletedAt), eq(tasks.account, d.account), eq(tasks.tasklist, d.tasklist), eq(tasks.parent, d.googleId)))
      .all();
    for (const kid of kids) {
      if (d.tasklist === keep.tasklist) {
        try {
          await api.tasks.move({ tasklist: keep.tasklist, task: kid.googleId, parent: keep.googleId });
          movedSubtasks++;
        } catch (e) {
          console.log(`[merge] サブタスク移動失敗 (${kid.title}): ${String(e).slice(0, 120)}`);
        }
      }
    }
  }

  // 2) keep の空欄を drop から補完 + gakujoマーカー集約
  const patch: Record<string, unknown> = {};
  const src = [keep, ...drops];
  const firstOf = (pick: (r: Row) => unknown) => src.map(pick).find((v) => v != null && v !== "");
  if (keep.estimatedMin == null) { const v = firstOf((r) => r.estimatedMin); if (v != null) patch.estimatedMin = v; }
  if (keep.priority == null) { const v = firstOf((r) => r.priority); if (v != null) patch.priority = v; }
  if (keep.dueTime == null) { const v = firstOf((r) => r.dueTime); if (v != null) patch.dueTime = v; }
  if (keep.due == null) { const v = firstOf((r) => r.due); if (v != null) patch.due = v; }
  // メモ: keep優先。drop側にしか無い本文（設問文など）があれば追記。gakujoマーカーは末尾に集約。
  const markers = gakujoMarkers(keep.notes, ...drops.map((d) => d.notes));
  const stripMarker = (s: string | null) => (s ?? "").replace(/\n*\[gakujo:[0-9a-f]+\]/g, "").trim();
  const keepBody = stripMarker(keep.notes);
  const extraBody = drops.map((d) => stripMarker(d.notes)).find((b) => b && !keepBody.includes(b.slice(0, 40)));
  const newNotes = [keepBody, extraBody && extraBody !== keepBody ? extraBody : "", ...markers].filter(Boolean).join("\n").trim();
  if (newNotes && newNotes !== (keep.notes ?? "")) patch.notes = newNotes;

  if (Object.keys(patch).length > 0) {
    db.update(tasks).set(patch).where(eq(tasks.googleId, keep.googleId)).run();
    // Google所有列(due/notes)が変わったら本体もpatch
    if ("due" in patch || "notes" in patch) {
      await api.tasks
        .patch({ tasklist: keep.tasklist, task: keep.googleId, requestBody: { notes: patch.notes as string ?? keep.notes ?? undefined, due: patch.due ? new Date(`${patch.due}T00:00:00Z`).toISOString() : undefined } })
        .catch((e) => console.log(`[merge] keep本体patch失敗: ${String(e).slice(0, 120)}`));
    }
  }

  // 3) drop を Google からも削除
  for (const d of drops) {
    try {
      await api.tasks.delete({ tasklist: d.tasklist, task: d.googleId });
    } catch (e) {
      console.log(`[merge] drop削除失敗 (${d.title}): ${String(e).slice(0, 120)}`);
    }
    db.update(tasks).set({ deletedAt: Date.now() }).where(eq(tasks.googleId, d.googleId)).run();
  }

  // 4) 影響したリストを再同期（サブタスクのparent反映）
  const lists = new Set([keep.tasklist, ...drops.map((d) => d.tasklist)]);
  for (const tl of lists) await syncTasks(keep.account, tl).catch(() => {});

  console.log(`[merge] 「${keep.title}」に${drops.length}件を統合（サブタスク${movedSubtasks}件移動）`);
  return { merged: drops.length, movedSubtasks };
}
