import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { listMessages, listThreadProposals, resolveThread, sendChat, type ChatFile } from "@/lib/chat";
import { saveUploadImage } from "@/lib/logs";
import { uploadSetError } from "@/lib/upload-limits";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 30_000_000; // per attachment (images / PDF / text)
const MAX_FILES = 4;
const MAX_TOTAL_BYTES = 120_000_000;

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
    body.power = form.get("power") === "1";
    const raw = form.getAll("files").filter((f): f is File => f instanceof File);
    const uploadError = uploadSetError(raw, { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
    if (uploadError) return Response.json({ detail: uploadError }, { status: 400 });
    for (const f of raw) {
      const abs = await saveUploadImage(Buffer.from(await f.arrayBuffer()), f.name || "file");
      files.push({ path: abs, name: f.name || "file" });
    }
  } else {
    body = await req.json();
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message && files.length === 0)
    return Response.json({ detail: "message required" }, { status: 400 });

  const opts = {
    taskKey: (body.taskKey as string) ?? null,
    thread: (body.thread as string) ?? null,
    message: message || "（添付ファイルを見てください）",
    agent: typeof body.agent === "string" ? body.agent : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    effort: typeof body.effort === "string" ? body.effort : undefined,
    power: body.power === true,
    files,
  };

  // ?stream=1 → SSE: live narration events ({t:"ev"}) then the result ({t:"done"}).
  if (new URL(req.url).searchParams.get("stream") === "1") {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = (obj: unknown) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch { /* client disconnected — the chat still lands in the DB */ }
        };
        const ping = setInterval(() => send({ t: "ping" }), 15_000); // keep proxies alive
        sendChat({ ...opts, onEvent: (line) => send({ t: "ev", line }) })
          .then((result) => send({ t: "done", ...result }))
          .catch((e) => send({ t: "done", ok: false, error: String(e) }))
          .finally(() => {
            clearInterval(ping);
            try { controller.close(); } catch { /* already closed */ }
          });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const result = await sendChat(opts);
  return Response.json(result);
}
