import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { buildPlan } from "@/lib/planner";
import { enrichTasks } from "@/lib/task-enrich";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** GET ?days=3 → 空き時間へのタスク配置プラン + 今やること。AI不使用・即答。 */
export async function GET(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const days = Math.min(7, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 3)));
  return Response.json(buildPlan(days));
}

/** POST {enrich:true, force?} → RAG+AIで見積り・優先度を一括推定（時間がかかる）。 */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { enrich?: boolean; force?: boolean };
  if (!body.enrich) return Response.json({ detail: "enrich:true が必要です" }, { status: 400 });
  const r = await enrichTasks({ force: body.force === true });
  return Response.json({ ...r, plan: buildPlan(3) });
}
