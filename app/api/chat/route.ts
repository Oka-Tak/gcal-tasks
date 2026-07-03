import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { listMessages, listThreadProposals, resolveThread, sendChat } from "@/lib/chat";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const threadId = resolveThread({ thread: sp.get("thread"), taskKey: sp.get("taskKey") });
  return Response.json({
    messages: listMessages(threadId),
    proposals: listThreadProposals(threadId),
  });
}

export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ detail: "message required" }, { status: 400 });
  const result = await sendChat({
    taskKey: body.taskKey ?? null,
    thread: body.thread ?? null,
    message,
    agent: typeof body.agent === "string" ? body.agent : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    effort: typeof body.effort === "string" ? body.effort : undefined,
  });
  return Response.json(result);
}
