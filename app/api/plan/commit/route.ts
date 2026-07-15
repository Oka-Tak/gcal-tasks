import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { commitPlanBlock } from "@/lib/plan-commit";

export const runtime = "nodejs";

/**
 * POST {taskKey, startMs, endMs} — 🧭プランのブロックを📌確定し、
 * 専用カレンダー「Kairos プラン」のGoogle予定に昇格させる。
 * プランナーは確定分をそのタスクの残り見積りから差し引く。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as
    | { taskKey?: string; startMs?: number; endMs?: number }
    | null;
  if (!b?.taskKey || !Number.isFinite(b.startMs) || !Number.isFinite(b.endMs))
    return Response.json({ detail: "taskKey/startMs/endMs が必要です" }, { status: 400 });
  try {
    const r = await commitPlanBlock({ taskKey: b.taskKey, startMs: b.startMs!, endMs: b.endMs! });
    return Response.json(r);
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e).slice(0, 300) }, { status: 400 });
  }
}
