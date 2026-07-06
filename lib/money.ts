import crypto from "node:crypto";
import { and, desc, gte, isNull, lt } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { expenses } from "./db/schema";
import { extractJson, runAgent } from "./agent";
import { CATEGORY_LABEL, EXPENSE_CATEGORIES, isExpenseCategory } from "./money-shared";

/**
 * お金管理（軽量ログ型）: クイック入力・レシート/決済スクショのAI取り込み・
 * 月次サマリ。銀行連携はしない（手入力とスクショで十分回る規模の設計）。
 */

export { CATEGORY_LABEL, EXPENSE_CATEGORIES, isExpenseCategory };

export interface ExpenseView {
  id: string;
  amountYen: number;
  category: string;
  title: string | null;
  note: string | null;
  whenMs: number;
  source: string | null;
  createdAt: number | null;
}

type Row = typeof expenses.$inferSelect;
const view = (r: Row): ExpenseView => ({
  id: r.id,
  amountYen: r.amountYen,
  category: r.category,
  title: r.title,
  note: r.note,
  whenMs: r.whenMs,
  source: r.source,
  createdAt: r.createdAt,
});

export function createExpense(e: {
  amountYen: number;
  category: string;
  title?: string | null;
  note?: string | null;
  whenMs?: number | null;
  source?: string | null;
  imagePath?: string | null;
}): ExpenseView {
  const now = Date.now();
  const row: typeof expenses.$inferInsert = {
    id: crypto.randomUUID(),
    amountYen: Math.round(e.amountYen),
    category: isExpenseCategory(e.category) ? e.category : "other",
    title: e.title?.slice(0, 200) ?? null,
    note: e.note?.slice(0, 2000) ?? null,
    whenMs: e.whenMs ?? now,
    source: e.source ?? "manual",
    imagePath: e.imagePath ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(expenses).values(row).run();
  return view(row as Row);
}

export function updateExpense(id: string, patch: {
  amountYen?: number; category?: string; title?: string | null;
  note?: string | null; whenMs?: number;
}): void {
  db.update(expenses)
    .set({
      ...(patch.amountYen != null && { amountYen: Math.round(patch.amountYen) }),
      ...(patch.category != null && isExpenseCategory(patch.category) && { category: patch.category }),
      ...("title" in patch && { title: patch.title ?? null }),
      ...("note" in patch && { note: patch.note ?? null }),
      ...(patch.whenMs != null && { whenMs: patch.whenMs }),
      updatedAt: Date.now(),
    })
    .where(eq(expenses.id, id))
    .run();
}

export function deleteExpense(id: string): void {
  db.update(expenses).set({ deletedAt: Date.now() }).where(eq(expenses.id, id)).run();
}

export function listExpenses(minMs: number, maxMs: number): ExpenseView[] {
  return db
    .select()
    .from(expenses)
    .where(and(isNull(expenses.deletedAt), gte(expenses.whenMs, minMs), lt(expenses.whenMs, maxMs)))
    .orderBy(desc(expenses.whenMs))
    .all()
    .map(view);
}

export interface MonthSummary {
  totalYen: number;
  byCategory: { category: string; yen: number }[];
  prevTotalYen: number; // 先月の同日まで（ペース比較用）
  prevMonthTotalYen: number; // 先月まるごと
  days: number; // 集計対象の経過日数
}

export function monthSummary(year: number, month0: number, now = new Date()): MonthSummary {
  const start = new Date(year, month0, 1).getTime();
  const end = new Date(year, month0 + 1, 1).getTime();
  const rows = listExpenses(start, end);
  const byCat = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    total += r.amountYen;
    byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.amountYen);
  }
  const isCurrent = now.getFullYear() === year && now.getMonth() === month0;
  const dayOfMonth = isCurrent ? now.getDate() : new Date(end - 1).getDate();
  const prevStart = new Date(year, month0 - 1, 1).getTime();
  const prevSameDay = new Date(year, month0 - 1, dayOfMonth, 23, 59, 59).getTime();
  const prevEnd = new Date(year, month0, 1).getTime();
  const prevRows = listExpenses(prevStart, prevEnd);
  return {
    totalYen: total,
    byCategory: [...byCat.entries()]
      .map(([category, yen]) => ({ category, yen }))
      .sort((a, b) => b.yen - a.yen),
    prevTotalYen: prevRows.filter((r) => r.whenMs <= prevSameDay).reduce((s, r) => s + r.amountYen, 0),
    prevMonthTotalYen: prevRows.reduce((s, r) => s + r.amountYen, 0),
    days: dayOfMonth,
  };
}

/* --------------------------------------------------- screenshot extraction */

interface RawExpense {
  amountYen?: number; category?: string; title?: string;
  note?: string; when?: string;
}

/** レシート/決済アプリのスクショから支出ドラフトを抽出（保存はしない）。 */
export async function extractExpenseFromImage(imageAbs: string): Promise<{
  drafts: { amountYen: number; category: string; title: string | null; note: string | null; whenMs: number | null }[];
  ok: boolean;
  error?: string;
  jobId: string;
}> {
  const nowISO = new Date().toISOString();
  const res = await runAgent(
    [
      `今日は ${nowISO} です（参照用）。`,
      `画像ファイル ${imageAbs} を Read ツールで開いてください。レシート、または決済アプリ（PayPay等）・ネット通販の支払い画面のスクリーンショットです。`,
      `読み取れる【支払い】を、次の JSON 配列だけで出力してください（前後に文章・コードフェンス不要）。`,
      `[{`,
      `  "amountYen": 支払額の数値(円),`,
      `  "category": "${EXPENSE_CATEGORIES.join('" | "')}",`,
      `  "title": "店名や品目の短い見出し",`,
      `  "note": "補足（任意）",`,
      `  "when": "支払日時 ISO8601 ローカル 例 2026-07-06T12:30:00（読めなければ null）"`,
      `}]`,
      `複数の支払いが写っていれば複数要素。合計と明細が両方見える場合は合計1件にする。`,
      `読み取れない場合は [] を返す。推測で金額を作らないこと。`,
    ].join("\n"),
    { agent: "claude", allowedTools: ["Read"], imagePaths: [imageAbs], jobKind: "extract-expense" },
  );
  if (!res.ok) return { drafts: [], ok: false, error: res.error, jobId: res.jobId };
  const parsed = extractJson<RawExpense[]>(res.text);
  if (!Array.isArray(parsed)) return { drafts: [], ok: false, error: "抽出結果をJSONとして解釈できませんでした", jobId: res.jobId };
  const drafts = parsed
    .filter((p) => typeof p.amountYen === "number" && p.amountYen > 0)
    .slice(0, 10)
    .map((p) => ({
      amountYen: Math.round(p.amountYen as number),
      category: isExpenseCategory(p.category) ? p.category : "other",
      title: p.title?.slice(0, 200) ?? null,
      note: p.note?.slice(0, 500) || null,
      whenMs: p.when ? (Number.isNaN(Date.parse(p.when)) ? null : Date.parse(p.when)) : null,
    }));
  return { drafts, ok: true, jobId: res.jobId };
}

/** ブリーフィング用: 昨日の支出1行（なければ null）。 */
export function yesterdaySpendLine(now: Date): string | null {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const rows = listExpenses(dayStart - 86_400_000, dayStart);
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.amountYen, 0);
  const top = [...rows].sort((a, b) => b.amountYen - a.amountYen)[0];
  return `・支出 ¥${total.toLocaleString()}（${rows.length}件、最大: ${top.title ?? CATEGORY_LABEL[top.category] ?? top.category} ¥${top.amountYen.toLocaleString()}）`;
}
