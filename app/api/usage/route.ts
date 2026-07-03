import { auth } from "@/auth";
import { usageReport } from "@/lib/usage";
import { agentQuotas } from "@/lib/quota";

export const runtime = "nodejs";

/** AI usage: remaining quota per CLI (best-effort) + spend aggregated from agent_jobs. */
export async function GET() {
  const session = await auth();
  if (!session?.user)
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const [report, quotas] = await Promise.all([usageReport(30), agentQuotas()]);
  return Response.json({ ...report, quotas });
}
