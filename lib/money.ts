import crypto from "node:crypto";
import { and, desc, gte, isNull, lt } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { expenses } from "./db/schema";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractJson, runAgentAuto } from "./agent";
import { runVisionAuto } from "./vision";
import { CATEGORY_LABEL, EXPENSE_CATEGORIES, isExpenseCategory } from "./money-shared";
import { InputError } from "./write-validation";

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
  if (!Number.isFinite(e.amountYen) || e.amountYen === 0 || Math.abs(e.amountYen) > 10_000_000) {
    throw new InputError("amountYen must be a non-zero number up to 10,000,000");
  }
  if (!isExpenseCategory(e.category)) throw new InputError("invalid expense category");
  if (e.whenMs != null && (!Number.isFinite(e.whenMs) || e.whenMs < 0)) throw new InputError("invalid whenMs");
  const now = Date.now();
  const row: typeof expenses.$inferInsert = {
    id: crypto.randomUUID(),
    amountYen: Math.round(e.amountYen),
    category: e.category,
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
  if (patch.amountYen !== undefined && (!Number.isFinite(patch.amountYen) || patch.amountYen === 0 || Math.abs(patch.amountYen) > 10_000_000)) {
    throw new InputError("amountYen must be a non-zero number up to 10,000,000");
  }
  if (patch.category !== undefined && !isExpenseCategory(patch.category)) throw new InputError("invalid expense category");
  if (patch.whenMs !== undefined && (!Number.isFinite(patch.whenMs) || patch.whenMs < 0)) throw new InputError("invalid whenMs");
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
  const spec = [
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
  ].join("\n");
  // claude limit時はローカルOCR+別LLMへ自動フォールバック（docs/AGENT-FALLBACK.md）
  const res = await runVisionAuto({
    visionPrompt: [
      `今日は ${nowISO} です（参照用）。`,
      `画像ファイル ${imageAbs} を Read ツールで開いてください。レシート、または決済アプリ（PayPay等）・ネット通販の支払い画面のスクリーンショットです。`,
      spec,
    ].join("\n"),
    ocrPrompt: (ocrText) => [
      `今日は ${nowISO} です（参照用）。`,
      `以下はレシート/決済画面のスクリーンショットをOCRしたテキストです（行順は画面の上から。誤認識を含みます）。`,
      spec,
      ``,
      `# OCRテキスト`,
      ocrText,
    ].join("\n"),
    imageAbs,
    jobKind: "extract-expense",
  });
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

/** 明細ファイルの対応拡張子。csv/txtは生読み、pdf/xlsxはextract-text.pyで抽出。 */
export const EXPENSE_FILE_EXT = new Set([".csv", ".txt", ".tsv", ".pdf", ".xlsx", ".xls"]);
const SELF_EXTRACT = new Set([".pdf", ".xlsx", ".xls"]);
const EXTRACT_PY = path.join(process.cwd(), "scripts", "extract-text.py");
const EXTRACT_PYTHON =
  process.env.KAIROS_EXTRACT_PYTHON ??
  path.join(os.homedir(), ".local", "share", "uv", "tools", "open-webui", "bin", "python");

function extractDocText(abs: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(EXTRACT_PYTHON, [EXTRACT_PY, abs], { maxBuffer: 12_000_000, timeout: 120_000 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/**
 * 明細ファイル（銀行・クレカ・PayPay等のCSV/PDF/Excelエクスポート）から
 * 支出ドラフトを一括抽出する（保存はしない — UIで確認して一括登録）。
 * 列レイアウトが提供元ごとに違うのでAIに解釈させる。入金・振替・残高は除外。
 */
export async function extractExpensesFromFile(fileAbs: string, filename: string): Promise<{
  drafts: { amountYen: number; category: string; title: string | null; note: string | null; whenMs: number | null }[];
  ok: boolean;
  error?: string;
  jobId: string;
}> {
  const ext = path.extname(filename).toLowerCase();
  let text: string | null;
  if (SELF_EXTRACT.has(ext)) text = await extractDocText(fileAbs);
  else text = await fs.readFile(fileAbs, "utf8").catch(async () => {
    // CSVはcp932(Shift-JIS)のことが多い — iconvせず bufferをlatin1で読んで判定は諦め、
    // まずutf8、ダメなら生バイトをそのまま渡す（AI側がある程度読める）
    const buf = await fs.readFile(fileAbs).catch(() => null);
    return buf ? buf.toString("utf8") : null;
  });
  if (!text?.trim()) return { drafts: [], ok: false, error: "ファイルからテキストを取り出せませんでした", jobId: "" };

  const nowISO = new Date().toISOString();
  const prompt = [
    `今日は ${nowISO} です（参照用）。`,
    `以下は銀行・クレジットカード・決済アプリ（PayPay等）・家計簿の利用明細ファイル（${filename}）の中身です。`,
    `ここから【支出（出金・引き落とし・カード利用）】だけを抜き出してください。`,
    `入金・給与・振込受取・残高・振替（自分の口座間移動）・ポイント付与は除外すること。`,
    `返却フォーマットは次の JSON 配列だけ（前後に文章・コードフェンス不要）:`,
    `[{`,
    `  "amountYen": 支出額の数値(円・正の整数),`,
    `  "category": "${EXPENSE_CATEGORIES.join('" | "')}",`,
    `  "title": "利用先・店名・品目の短い見出し",`,
    `  "note": "補足（任意・カード名や明細の備考など）",`,
    `  "when": "利用日 ISO8601 例 2026-07-06（時刻不明なら日付のみ、読めなければ null）"`,
    `}]`,
    `金額の符号やカッコで出金を表す形式（例 -1200 や △1200 や (1200)）は支出として正の数にする。`,
    `カテゴリは店名・用途から推定（食料品店・コンビニ→meal、交通→transport等）。不明は other。`,
    `推測で金額や件数を水増ししない。明細が無ければ [] を返す。`,
    ``,
    `# 明細`,
    text.slice(0, 60_000),
  ].join("\n");

  // 家計簿の一括取り込みは背景ジョブ扱い（claude枠が薄ければ自動フォールバック）
  const res = await runAgentAuto(prompt, { jobKind: "import-expenses", timeoutMs: 300_000 });
  if (!res.ok) return { drafts: [], ok: false, error: res.error, jobId: res.jobId };
  const parsed = extractJson<RawExpense[]>(res.text);
  if (!Array.isArray(parsed)) return { drafts: [], ok: false, error: "抽出結果をJSONとして解釈できませんでした", jobId: res.jobId };
  const drafts = parsed
    .filter((p) => typeof p.amountYen === "number" && p.amountYen > 0)
    .slice(0, 300)
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
