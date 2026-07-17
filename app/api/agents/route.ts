import { auth } from "@/auth";
import { liveAgentCatalog } from "@/lib/agents-live";
import { loadPriority, savePriorityOrder } from "@/lib/agent-priority";
import { type NextRequest } from "next/server";

export const runtime = "nodejs";

/** エージェント/モデルのライブカタログ（UIセレクタ用）。 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  return Response.json({ catalog: await liveAgentCatalog(), priority: loadPriority() });
}

/** PUT {order: ["claude","codex",…], probe?} — バックグラウンドAIのフォールバック優先順位。 */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { order?: string[]; probe?: boolean } | null;
  if (!b || !Array.isArray(b.order)) return Response.json({ detail: "order (string[]) が必要です" }, { status: 400 });
  try {
    return Response.json({ priority: await savePriorityOrder(b.order, b.probe) });
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e) }, { status: 400 });
  }
}
