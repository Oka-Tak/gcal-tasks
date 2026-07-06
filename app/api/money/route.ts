import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import {
  createExpense, deleteExpense, extractExpenseFromImage, listExpenses,
  monthSummary, updateExpense,
} from "@/lib/money";
import { saveUploadImage } from "@/lib/logs";

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
  const month0 = Number(sp.get("month") ?? now.getMonth() + 1) - 1;
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
  if (!Number.isFinite(amountYen) || amountYen === 0)
    return Response.json({ detail: "amountYen は 0 以外の数値です" }, { status: 400 });
  const created = createExpense({
    amountYen,
    category: String(b.category ?? "other"),
    title: typeof b.title === "string" ? b.title : null,
    note: typeof b.note === "string" ? b.note : null,
    whenMs: typeof b.whenMs === "number" ? b.whenMs : undefined,
    source: "manual",
  });
  return Response.json({ ok: true, created });
}

export async function PATCH(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json()) as Record<string, unknown>;
  if (typeof b.id !== "string") return Response.json({ detail: "id required" }, { status: 400 });
  updateExpense(b.id, {
    amountYen: typeof b.amountYen === "number" ? b.amountYen : undefined,
    category: typeof b.category === "string" ? b.category : undefined,
    ...(typeof b.title === "string" || b.title === null ? { title: b.title as string | null } : {}),
    ...(typeof b.note === "string" || b.note === null ? { note: b.note as string | null } : {}),
    whenMs: typeof b.whenMs === "number" ? b.whenMs : undefined,
  });
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  deleteExpense(id);
  return new Response(null, { status: 204 });
}
