import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { events, tasks } from "./db/schema";
import { dayMatches, listRoutines } from "./routines";
import { parentTaskIdentity, taskIdentity } from "./task-identity";

/**
 * プランナー: 予定（Google カレンダー）と生活ルーチンで埋まっていない
 * 起床時間の空きスロットに、未完了タスクを締切前に収まるよう配置する。
 * 並び: ASAP →（同着は優先度降順）→ 期日昇順 → 優先度降順。
 * 見積りが無いタスクは60分と仮置き（AI一括推定 task-enrich が埋める）。
 * 決定的・軽量（AI不使用）なので毎回その場で計算する。
 */

export interface PlanBlock {
  kind: "task" | "deadline";
  title: string;
  startMs: number;
  endMs: number; // deadline は start=end のマーカー
  taskKey?: string; // account|tasklist|googleId
  note?: string;
}

export interface NowAction {
  kind: "event" | "task" | "routine" | "free";
  title: string;
  untilMs: number | null;
  note?: string;
}

export interface PlanResult {
  blocks: PlanBlock[];
  now: NowAction | null;
  warnings: string[]; // 期限に収まらない等
  generatedAt: number;
}

interface Slot { s: number; e: number }

const CHUNK_MAX_MIN = 120; // 集中の上限 — これを超えるタスクは分割して置く
const SLOT_MIN_MIN = 15; // これ未満の隙間には置かない
const DEFAULT_EST_MIN = 60;

const minsOf = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

function mergeBusy(list: Slot[]): Slot[] {
  const sorted = list.slice().sort((a, b) => a.s - b.s);
  const out: Slot[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push({ ...x });
  }
  return out;
}

function subtract(win: Slot, busy: Slot[]): Slot[] {
  let free: Slot[] = [win];
  for (const b of busy) {
    const next: Slot[] = [];
    for (const f of free) {
      if (b.e <= f.s || b.s >= f.e) { next.push(f); continue; }
      if (b.s > f.s) next.push({ s: f.s, e: b.s });
      if (b.e < f.e) next.push({ s: b.e, e: f.e });
    }
    free = next;
  }
  return free.filter((f) => f.e - f.s >= SLOT_MIN_MIN * 60_000);
}

export function buildPlan(horizonDays = 3): PlanResult {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rts = listRoutines().filter((r) => r.active);
  const sleep = rts.find((r) => r.kind === "sleep");
  const wakeMin = sleep?.endHm ? minsOf(sleep.endHm) : 7 * 60;
  let bedMin = sleep?.startHm ? minsOf(sleep.startHm) : 24 * 60;
  if (bedMin <= wakeMin) bedMin += 24 * 60; // 就寝が0時過ぎ = 翌日にまたぐ

  const horizonEnd = today.getTime() + horizonDays * 86_400_000 + bedMin * 60_000;
  const evRows = db
    .select()
    .from(events)
    .where(isNull(events.deletedAt))
    .all()
    .filter((e) => e.status !== "cancelled" && !e.allDay && e.startMs != null && e.endMs != null)
    .filter((e) => e.endMs! > now && e.startMs! < horizonEnd);

  // 空きスロット（日ごとに 起床〜就寝 から予定+blockルーチンを引く）
  const slots: Slot[] = [];
  const deadlineMarks: PlanBlock[] = [];
  for (let d = 0; d < horizonDays; d++) {
    const day = new Date(today.getTime() + d * 86_400_000);
    const dayStart = day.getTime() + wakeMin * 60_000;
    const dayEnd = day.getTime() + bedMin * 60_000;
    if (dayEnd <= now) continue;
    const busy: Slot[] = evRows
      .filter((e) => e.startMs! < dayEnd && e.endMs! > dayStart)
      .map((e) => ({ s: e.startMs!, e: e.endMs! }));
    for (const r of rts) {
      if (r.kind !== "block" || !dayMatches(r.days, day) || !r.startHm || !r.endHm) continue;
      busy.push({ s: day.getTime() + minsOf(r.startHm) * 60_000, e: day.getTime() + minsOf(r.endHm) * 60_000 });
    }
    for (const r of rts) {
      if (r.kind !== "deadline" || !dayMatches(r.days, day) || !r.endHm) continue;
      const at = day.getTime() + minsOf(r.endHm) * 60_000;
      if (at > now) deadlineMarks.push({ kind: "deadline", title: r.label, startMs: at, endMs: at, note: r.note ?? undefined });
    }
    slots.push(...subtract({ s: Math.max(now, dayStart), e: dayEnd }, mergeBusy(busy)));
  }
  slots.sort((a, b) => a.s - b.s);

  // タスク（ASAP or 期限あり、未完了）を締切順に空きへ流し込む。
  // サブタスク（sub-issue）を持つ親はサブタスク単位で置く — 期限・ASAP・
  // 優先度は子に無ければ親から継承、並びは Google の position 順。
  const allOpen = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all();
  type Row = (typeof allOpen)[0];
  const kids = new Map<string, Row[]>();
  for (const t of allOpen) {
    const parentKey = parentTaskIdentity(t);
    if (!parentKey) continue;
    (kids.get(parentKey) ?? kids.set(parentKey, []).get(parentKey)!).push(t);
  }
  interface WorkItem { title: string; estMin: number; dueYmd: string | null; dueTime: string | null; asap: boolean; priority: number; taskKey: string; seq: number }
  const items: WorkItem[] = [];
  for (const t of allOpen) {
    if (t.parent || (!t.asap && !t.due)) continue;
    const children = (kids.get(taskIdentity(t)) ?? []).sort((a, b) => (a.position ?? "").localeCompare(b.position ?? ""));
    if (children.length > 0) {
      children.forEach((c, i) =>
        items.push({
          title: `${t.title ?? ""}: ${c.title ?? "(無題)"}`,
          estMin: c.estimatedMin ?? Math.max(SLOT_MIN_MIN, Math.round((t.estimatedMin ?? DEFAULT_EST_MIN) / children.length)),
          dueYmd: (c.due ?? t.due)?.slice(0, 10) ?? null,
          dueTime: c.due ? c.dueTime : t.dueTime,
          asap: !!(c.asap || t.asap),
          priority: c.priority ?? t.priority ?? 0,
          taskKey: taskIdentity(c),
          seq: i,
        }),
      );
    } else {
      items.push({
        title: t.title ?? "(無題)",
        estMin: t.estimatedMin ?? DEFAULT_EST_MIN,
        dueYmd: t.due?.slice(0, 10) ?? null,
        dueTime: t.dueTime,
        asap: !!t.asap,
        priority: t.priority ?? 0,
        taskKey: taskIdentity(t),
        seq: 0,
      });
    }
  }
  const key = (w: WorkItem) =>
    `${w.asap ? "0" : "1"}|${w.dueYmd ? `${w.dueYmd}T${w.dueTime ?? "23:59"}` : "9999"}|${9 - w.priority}|${String(w.seq).padStart(3, "0")}`;
  items.sort((a, b) => key(a).localeCompare(key(b)));

  const blocks: PlanBlock[] = [];
  const warnings: string[] = [];
  for (const w of items) {
    let remain = Math.max(SLOT_MIN_MIN, w.estMin) * 60_000;
    const limit = w.dueYmd ? new Date(`${w.dueYmd}T${w.dueTime ?? "23:59"}:00`).getTime() : Number.POSITIVE_INFINITY;
    for (const slot of slots) {
      if (remain <= 0) break;
      if (slot.e - slot.s < SLOT_MIN_MIN * 60_000) continue;
      const end = Math.min(slot.e, slot.s + Math.min(remain, CHUNK_MAX_MIN * 60_000), limit);
      if (end - slot.s < SLOT_MIN_MIN * 60_000) continue;
      blocks.push({ kind: "task", title: w.title, startMs: slot.s, endMs: end, taskKey: w.taskKey });
      remain -= end - slot.s;
      slot.s = end; // スロットを消費
    }
    if (remain > 0 && Number.isFinite(limit)) {
      warnings.push(`「${w.title}」が期限までに約${Math.ceil(remain / 60_000)}分ぶん収まりません`);
    }
  }
  blocks.push(...deadlineMarks);
  blocks.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // 今なにをするか: 進行中の予定 > 進行中のblockルーチン > 現在のプランブロック > 次のブロック
  let nowAction: NowAction | null = null;
  const curEv = evRows.find((e) => e.startMs! <= now && e.endMs! > now);
  if (curEv) nowAction = { kind: "event", title: curEv.summary ?? "(予定)", untilMs: curEv.endMs! };
  if (!nowAction) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    for (const r of rts) {
      if (r.kind !== "block" || !dayMatches(r.days, day) || !r.startHm || !r.endHm) continue;
      const s = day.getTime() + minsOf(r.startHm) * 60_000;
      const e = day.getTime() + minsOf(r.endHm) * 60_000;
      if (s <= now && e > now) { nowAction = { kind: "routine", title: r.label, untilMs: e }; break; }
    }
  }
  if (!nowAction) {
    const cur = blocks.find((b) => b.kind === "task" && b.startMs <= now && b.endMs > now);
    const next = blocks.find((b) => b.kind === "task" && b.startMs > now);
    if (cur) nowAction = { kind: "task", title: cur.title, untilMs: cur.endMs };
    else if (next) nowAction = { kind: "free", title: `次: ${next.title}`, untilMs: next.startMs };
    else nowAction = { kind: "free", title: "予定・タスクなし（自由時間）", untilMs: null };
  }

  return { blocks, now: nowAction, warnings, generatedAt: now };
}
