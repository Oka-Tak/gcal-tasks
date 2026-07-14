import crypto from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "./db";
import { routines } from "./db/schema";

/**
 * 日常の生活ルール（タスクではないがプランナーの制約になる）:
 *  - block:    その時間は作業に使えない（風呂・夕食・バイト・洗濯など）
 *  - deadline: その時刻までに済ませる区切り（例: 20:10までに帰宅=寮の夕食）
 *  - sleep:    就寝(startHm)〜起床(endHm)。1日の可処分時間の境界になる
 * days は "mon,tue" 形式（null/空 = 毎日）。
 */

export type RoutineRow = typeof routines.$inferSelect;

export interface RoutineWrite {
  id?: string;
  label: string;
  kind: string; // block | deadline | sleep
  days?: string | null;
  startHm?: string | null;
  endHm?: string | null;
  note?: string | null;
  active?: boolean;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** ルーチンがこの日に適用されるか（days 未指定 = 毎日）。 */
export function dayMatches(days: string | null | undefined, d: Date): boolean {
  const s = (days ?? "").trim().toLowerCase();
  if (!s) return true;
  return s.split(/[,\s]+/).includes(DAY_KEYS[d.getDay()]);
}

export function listRoutines(): RoutineRow[] {
  return db.select().from(routines).orderBy(asc(routines.createdAt)).all();
}

export const isRoutineHm = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function upsertRoutine(w: RoutineWrite): RoutineRow {
  if (!w.label?.trim()) throw new Error("label が必要です");
  if (w.label.length > 200) throw new Error("label は200文字までです");
  if (!["block", "deadline", "sleep"].includes(w.kind)) throw new Error("kind は block/deadline/sleep");
  for (const hm of [w.startHm, w.endHm]) {
    if (hm && !isRoutineHm(hm)) throw new Error(`時刻は HH:MM 形式で: ${hm}`);
  }
  const dayList = (w.days ?? "").trim().toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (dayList.some((day) => !(DAY_KEYS as readonly string[]).includes(day))) {
    throw new Error("days は sun,mon,tue,wed,thu,fri,sat の組み合わせです");
  }
  if (w.note && w.note.length > 2000) throw new Error("note は2000文字までです");
  const now = Date.now();
  const id = w.id ?? crypto.randomUUID();
  const row: typeof routines.$inferInsert = {
    id,
    label: w.label.trim(),
    kind: w.kind,
    days: dayList.length ? [...new Set(dayList)].join(",") : null,
    startHm: w.startHm || null,
    endHm: w.endHm || null,
    note: w.note?.trim() || null,
    active: w.active ?? true,
    createdAt: now,
    updatedAt: now,
  };
  const existing = w.id ? db.select().from(routines).where(eq(routines.id, w.id)).get() : null;
  if (existing) {
    db.update(routines)
      .set({ ...row, createdAt: existing.createdAt, updatedAt: now })
      .where(eq(routines.id, id))
      .run();
  } else {
    db.insert(routines).values(row).run();
  }
  return db.select().from(routines).where(eq(routines.id, id)).get()!;
}

export function deleteRoutine(id: string): void {
  db.delete(routines).where(eq(routines.id, id)).run();
}

/** 初回だけの種まき（ユーザー例: 寮の夕食は20:10帰宅リミット、推奨睡眠7.5h）。 */
export function seedRoutines(): void {
  if (listRoutines().length > 0) return;
  upsertRoutine({ label: "寮の夕食（帰宅リミット）", kind: "deadline", endHm: "20:10", note: "20:10までに帰宅しないと食べ損ねる" });
  upsertRoutine({ label: "夕食", kind: "block", startHm: "19:30", endHm: "20:10" });
  upsertRoutine({ label: "推奨睡眠", kind: "sleep", startHm: "00:00", endHm: "07:30", note: "7.5時間" });
}
