import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import {
  createSubscription, deleteSubscription, listSubscriptions,
  subsMonthlyTotal, updateSubscription,
} from "@/lib/subscriptions";
import { InputError } from "@/lib/write-validation";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** GET → サブスク一覧 + 月額合計 */
export async function GET() {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  return Response.json({ subscriptions: listSubscriptions(), monthlyTotal: subsMonthlyTotal() });
}

/** POST {name, amountYen, category?, billingDay?, note?} → 1件登録 */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json()) as Record<string, unknown>;
  try {
    const created = createSubscription({
      name: typeof b.name === "string" ? b.name : "",
      amountYen: Number(b.amountYen),
      category: typeof b.category === "string" ? b.category : null,
      billingDay: typeof b.billingDay === "number" ? b.billingDay : null,
      note: typeof b.note === "string" ? b.note : null,
    });
    return Response.json({ ok: true, created });
  } catch (e) {
    if (e instanceof InputError) return Response.json({ detail: e.message }, { status: 400 });
    throw e;
  }
}

/** PATCH {id, ...} → 更新（active で稼働/停止トグルも） */
export async function PATCH(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json()) as Record<string, unknown>;
  if (typeof b.id !== "string" || !b.id.trim()) return Response.json({ detail: "id required" }, { status: 400 });
  try {
    updateSubscription(b.id, {
      ...(typeof b.name === "string" ? { name: b.name } : {}),
      ...(typeof b.amountYen === "number" ? { amountYen: b.amountYen } : {}),
      ...(typeof b.category === "string" ? { category: b.category } : {}),
      ...(typeof b.billingDay === "number" ? { billingDay: b.billingDay } : {}),
      ...("note" in b && (typeof b.note === "string" || b.note === null) ? { note: b.note as string | null } : {}),
      ...(typeof b.active === "boolean" ? { active: b.active } : {}),
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof InputError) return Response.json({ detail: e.message }, { status: 400 });
    throw e;
  }
}

/** DELETE ?id= → 停止（ソフト削除。過去の計上済み支出は残す） */
export async function DELETE(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  deleteSubscription(id);
  return new Response(null, { status: 204 });
}
