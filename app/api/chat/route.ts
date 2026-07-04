import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { listMessages, listThreadProposals, resolveThread, sendChat, type ChatFile } from "@/lib/chat";
import { saveUploadImage } from "@/lib/logs";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 30_000_000; // per attachment (images / PDF / text)
const MAX_FILES = 4;

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

  // multipart = message with attachments; JSON = plain message (unchanged)
  let body: Record<string, unknown>;
  const files: ChatFile[] = [];
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    body = Object.fromEntries(
      ["message", "thread", "taskKey", "agent", "model", "effort"].map((k) => [k, form.get(k)]),
    );
    const raw = form.getAll("files").filter((f): f is File => f instanceof File);
    if (raw.length > MAX_FILES)
      return Response.json({ detail: `添付は${MAX_FILES}件までです` }, { status: 400 });
    for (const f of raw) {
      if (f.size === 0 || f.size > MAX_FILE_BYTES)
        return Response.json({ detail: `ファイルが空か大きすぎます: ${f.name}` }, { status: 400 });
      const abs = await saveUploadImage(Buffer.from(await f.arrayBuffer()), f.name || "file");
      files.push({ path: abs, name: f.name || "file" });
    }
  } else {
    body = await req.json();
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message && files.length === 0)
    return Response.json({ detail: "message required" }, { status: 400 });
  const result = await sendChat({
    taskKey: (body.taskKey as string) ?? null,
    thread: (body.thread as string) ?? null,
    message: message || "（添付ファイルを見てください）",
    agent: typeof body.agent === "string" ? body.agent : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    effort: typeof body.effort === "string" ? body.effort : undefined,
    files,
  });
  return Response.json(result);
}
