import crypto from "node:crypto";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { db } from "./db";
import { expenses, subscriptions } from "./db/schema";
import { createExpense, isExpenseCategory } from "./money";
import { InputError } from "./write-validation";

/**
 * サブスク（定期課金）＝都度の支出とは別建て。1回登録すれば、月を開くたびに
 * ensureMonthMaterialized() がその月ぶんを expenses に冪等生成する（kind=sub）ので、
 * 毎月の手入力が要らない。金額変更は以後の生成に効き、過去分は実請求額として残す。
 */

export interface SubscriptionView {
  id: string;
  name: string;
  amountYen: number;
  category: string;
  billingDay: number;
  note: string | null;
  active: boolean;
  startMs: number;
  createdAt: number | null;
}

type SubRow = typeof subscriptions.$inferSelect;
const view = (r: SubRow): SubscriptionView => ({
  id: r.id,
  name: r.name,
  amountYen: r.amountYen,
  category: r.category,
  billingDay: r.billingDay,
  note: r.note,
  active: !!r.active,
  startMs: r.startMs,
  createdAt: r.createdAt,
});

const clampDay = (d: unknown): number => {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, n)); // 月末揺れ回避で28上限
};

export function listSubscriptions(): SubscriptionView[] {
  return db
    .select()
    .from(subscriptions)
    .where(isNull(subscriptions.deletedAt))
    .orderBy(desc(subscriptions.active), desc(subscriptions.amountYen))
    .all()
    .map(view);
}

/** 稼働中サブスクの月額合計。 */
export function subsMonthlyTotal(): number {
  return db
    .select()
    .from(subscriptions)
    .where(and(isNull(subscriptions.deletedAt), eq(subscriptions.active, 1)))
    .all()
    .reduce((s, r) => s + r.amountYen, 0);
}

export function createSubscription(e: {
  name: string; amountYen: number; category?: string | null;
  billingDay?: number | null; note?: string | null; startMs?: number | null;
}): SubscriptionView {
  const name = (e.name ?? "").trim();
  if (!name) throw new InputError("サービス名は必須です");
  if (!Number.isFinite(e.amountYen) || e.amountYen <= 0 || e.amountYen > 10_000_000) {
    throw new InputError("月額は 1〜10,000,000 円で指定してください");
  }
  const now = Date.now();
  const nd = new Date();
  const row: typeof subscriptions.$inferInsert = {
    id: crypto.randomUUID(),
    name: name.slice(0, 120),
    amountYen: Math.round(e.amountYen),
    category: isExpenseCategory(e.category) ? (e.category as string) : "sub",
    billingDay: clampDay(e.billingDay ?? 1),
    note: e.note?.slice(0, 2000) ?? null,
    active: 1,
    // 既定は今月頭から計上開始（過去に遡って勝手に生成しない）
    startMs: e.startMs ?? new Date(nd.getFullYear(), nd.getMonth(), 1).getTime(),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(subscriptions).values(row).run();
  return view(row as SubRow);
}

export function updateSubscription(id: string, patch: {
  name?: string; amountYen?: number; category?: string; billingDay?: number;
  note?: string | null; active?: boolean;
}): void {
  if (patch.amountYen !== undefined && (!Number.isFinite(patch.amountYen) || patch.amountYen <= 0 || patch.amountYen > 10_000_000)) {
    throw new InputError("月額は 1〜10,000,000 円で指定してください");
  }
  db.update(subscriptions)
    .set({
      ...(patch.name !== undefined && { name: patch.name.trim().slice(0, 120) }),
      ...(patch.amountYen !== undefined && { amountYen: Math.round(patch.amountYen) }),
      ...(patch.category !== undefined && isExpenseCategory(patch.category) && { category: patch.category }),
      ...(patch.billingDay !== undefined && { billingDay: clampDay(patch.billingDay) }),
      ...("note" in patch && { note: patch.note ?? null }),
      ...(patch.active !== undefined && { active: patch.active ? 1 : 0 }),
      updatedAt: Date.now(),
    })
    .where(eq(subscriptions.id, id))
    .run();
}

/** サブスクを停止（ソフト削除）。過去に計上済みの支出は実請求額として残す。 */
export function deleteSubscription(id: string): void {
  db.update(subscriptions).set({ deletedAt: Date.now(), active: 0 }).where(eq(subscriptions.id, id)).run();
}

/**
 * 指定月の稼働中サブスクを expenses に生成（未生成のものだけ・冪等）。
 * 未来月は生成しない（当月まで）。削除済みの生成分は再生成しない
 * （ユーザーがその月だけ消したいケースを尊重）。戻り値＝新規生成した件数。
 */
export function ensureMonthMaterialized(year: number, month0: number, now = new Date()): number {
  const monthStart = new Date(year, month0, 1).getTime();
  const monthEnd = new Date(year, month0 + 1, 1).getTime();
  if (monthStart > now.getTime()) return 0; // 未来月は先に計上しない
  const subs = db
    .select()
    .from(subscriptions)
    .where(and(isNull(subscriptions.deletedAt), eq(subscriptions.active, 1)))
    .all();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  let created = 0;
  for (const s of subs) {
    if (s.startMs >= monthEnd) continue; // 開始月より前は対象外
    // この月に生成済みか（削除済みも含めチェック＝再生成しない）
    const existing = db
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.subscriptionId, s.id), gte(expenses.whenMs, monthStart), lt(expenses.whenMs, monthEnd)))
      .all();
    if (existing.length) continue;
    const day = Math.min(clampDay(s.billingDay), daysInMonth);
    const whenMs = new Date(year, month0, day, 12, 0, 0).getTime();
    createExpense({
      amountYen: s.amountYen,
      category: isExpenseCategory(s.category) ? s.category : "sub",
      title: s.name,
      note: s.note ?? null,
      whenMs,
      source: "sub",
      kind: "sub",
      subscriptionId: s.id,
    });
    created++;
  }
  return created;
}
