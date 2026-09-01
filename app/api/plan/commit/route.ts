import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { commitPlanBlock } from "@/lib/plan-commit";

export const runtime = "nodejs";

/**
 * POST {taskKey|travelTitle, startMs, endMs} — 🧭プランのブロックを📌確定し、
 * 専用カレンダー「Kairos プラン」のGoogle予定に昇格させる。
 * タスク枠は確定分を残り見積りから差し引く。移動枠(travelTitle)は移動そのものを
 * 予定として置き、当日その時間が埋まっていることをカレンダー上でも見えるようにする。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as
    | { taskKey?: string; travelTitle?: string; note?: string; startMs?: number; endMs?: number }
    | null;
  if ((!b?.taskKey && !b?.travelTitle) || !Number.isFinite(b?.startMs) || !Number.isFinite(b?.endMs))
    return Response.json({ detail: "taskKey か travelTitle と startMs/endMs が必要です" }, { status: 400 });
  try {
    const r = await commitPlanBlock({
      ...(b.taskKey ? { taskKey: b.taskKey } : { travelTitle: b.travelTitle, note: b.note }),
      startMs: b.startMs!,
      endMs: b.endMs!,
    });
    return Response.json(r);
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e).slice(0, 300) }, { status: 400 });
  }
}
