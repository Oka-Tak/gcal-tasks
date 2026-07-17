import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { findDuplicateTasks, mergeTasks } from "@/lib/tasks-merge";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** GET → 重複タスクのグループ一覧（正規化タイトル一致、2件以上）。 */
export async function GET() {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  return Response.json({ groups: findDuplicateTasks() });
}

/** POST {keep, drop:[...]} → keep に drop 群をマージ（サブタスク移動+情報統合+削除）。 */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { keep?: string; drop?: string[] } | null;
  if (!b?.keep || !Array.isArray(b.drop) || b.drop.length === 0)
    return Response.json({ detail: "keep と drop[] が必要です" }, { status: 400 });
  try {
    const r = await mergeTasks(b.keep, b.drop);
    return Response.json(r);
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e).slice(0, 300) }, { status: 400 });
  }
}
