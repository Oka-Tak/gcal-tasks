import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import {
  createExpense, deleteExpense, extractExpenseFromImage, listExpenses,
  monthSummary, updateExpense,
} from "@/lib/money";
import { saveUploadImage } from "@/lib/logs";
import { InputError } from "@/lib/write-validation";
import { isExpenseCategory } from "@/lib/money-shared";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 15_000_000;

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** GET /api/money?year=2026&month=7 → その月の一覧+サマリ */
export async function GET(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const now = new Date();
  const year = Number(sp.get("year") ?? now.getFullYear());
  const month = Number(sp.get("month") ?? now.getMonth() + 1);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return Response.json({ detail: "year/month が不正です" }, { status: 400 });
  }
  const month0 = month - 1;
  const start = new Date(year, month0, 1).getTime();
  const end = new Date(year, month0 + 1, 1).getTime();
  return Response.json({
    expenses: listExpenses(start, end),
    summary: monthSummary(year, month0),
  });
}

/**
 * POST JSON {amountYen, category, title?, note?, whenMs?} → 1件登録。
 * POST multipart (file=スクショ) → AI抽出して自動登録、登録内容を返す。
 */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });

  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File) || f.size === 0 || f.size > MAX_IMAGE_BYTES)
      return Response.json({ detail: "画像ファイルが不正です" }, { status: 400 });
    const abs = await saveUploadImage(Buffer.from(await f.arrayBuffer()), f.name || "receipt");
    const r = await extractExpenseFromImage(abs);
    if (!r.ok) return Response.json({ detail: r.error ?? "抽出に失敗しました" }, { status: 422 });
    if (!r.drafts.length) return Response.json({ detail: "支払いを読み取れませんでした" }, { status: 422 });
    const created = r.drafts.map((d) =>
      createExpense({ ...d, whenMs: d.whenMs ?? Date.now(), source: "screenshot", imagePath: abs }),
    );
    return Response.json({ ok: true, created });
  }

  const b = (await req.json()) as Record<string, unknown>;
  const amountYen = Number(b.amountYen);
  if (!Number.isFinite(amountYen) || amountYen === 0 || Math.abs(amountYen) > 10_000_000)
    return Response.json({ detail: "amountYen は 0 以外の数値です" }, { status: 400 });
  const category = b.category ?? "other";
  if (!isExpenseCategory(category)) return Response.json({ detail: "category が不正です" }, { status: 400 });
  if (b.whenMs !== undefined && (typeof b.whenMs !== "number" || !Number.isFinite(b.whenMs) || b.whenMs < 0)) {
    return Response.json({ detail: "whenMs が不正です" }, { status: 400 });
  }
  try {
    const created = createExpense({
      amountYen,
      category,
      title: typeof b.title === "string" ? b.title : null,
      note: typeof b.note === "string" ? b.note : null,
      whenMs: typeof b.whenMs === "number" ? b.whenMs : undefined,
      source: "manual",
    });
    return Response.json({ ok: true, created });
  } catch (e) {
    if (e instanceof InputError) return Response.json({ detail: e.message }, { status: 400 });
    throw e;
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json()) as Record<string, unknown>;
  if (typeof b.id !== "string" || !b.id.trim()) return Response.json({ detail: "id required" }, { status: 400 });
  if ("amountYen" in b && typeof b.amountYen !== "number") return Response.json({ detail: "amountYen が不正です" }, { status: 400 });
  if ("category" in b && !isExpenseCategory(b.category)) return Response.json({ detail: "category が不正です" }, { status: 400 });
  if ("whenMs" in b && typeof b.whenMs !== "number") return Response.json({ detail: "whenMs が不正です" }, { status: 400 });
  for (const key of ["title", "note"] as const) {
    if (key in b && b[key] !== null && typeof b[key] !== "string") return Response.json({ detail: `${key} が不正です` }, { status: 400 });
  }
  try {
    updateExpense(b.id, {
      amountYen: typeof b.amountYen === "number" ? b.amountYen : undefined,
      category: typeof b.category === "string" ? b.category : undefined,
      ...(typeof b.title === "string" || b.title === null ? { title: b.title as string | null } : {}),
      ...(typeof b.note === "string" || b.note === null ? { note: b.note as string | null } : {}),
      whenMs: typeof b.whenMs === "number" ? b.whenMs : undefined,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof InputError) return Response.json({ detail: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  deleteExpense(id);
  return new Response(null, { status: 204 });
}
