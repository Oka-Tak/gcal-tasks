import { auth } from "@/auth";
import { liveAgentCatalog } from "@/lib/agents-live";

export const runtime = "nodejs";

/** エージェント/モデルのライブカタログ（UIセレクタ用）。 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  return Response.json({ catalog: await liveAgentCatalog() });
}
