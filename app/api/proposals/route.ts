import { asc, eq } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { proposals } from "@/lib/db/schema";
import { decideProposal } from "@/lib/actions";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** List proposals — ?threadId= for a chat thread, ?status= (default "pending"). */
export async function GET(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const threadId = sp.get("threadId");
  const status = sp.get("status") ?? "pending";
  const rows = db
    .select()
    .from(proposals)
    .where(threadId ? eq(proposals.threadId, threadId) : eq(proposals.status, status))
    .orderBy(asc(proposals.createdAt))
    .all();
  return Response.json({ proposals: rows });
}

/** Decide a pending proposal: { id, decision: "approve" | "reject" }. Approve executes. */
export async function PATCH(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  const id = typeof body.id === "string" ? body.id : "";
  const decision = body.decision;
  if (!id || (decision !== "approve" && decision !== "reject"))
    return Response.json({ detail: "id / decision(approve|reject) required" }, { status: 400 });
  try {
    const proposal = await decideProposal(id, decision);
    return Response.json({ ok: proposal.status !== "error", proposal });
  } catch (e) {
    return Response.json({ detail: String(e) }, { status: 409 });
  }
}
