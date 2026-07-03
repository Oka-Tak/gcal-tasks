import path from "node:path";
import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { env } from "@/lib/env";
import { listLogs, listLogsRange, saveLog, softDeleteLog, type LogDraft } from "@/lib/logs";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

function toMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** Only keep an imagePath the server produced (inside the data dir). */
function safeImagePath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  const base = path.resolve(env.dataDir);
  const abs = path.resolve(p);
  return abs.startsWith(base + path.sep) ? abs : undefined;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  // ?timeMin=&timeMax= (ISO) → range mode for the calendar's actuals overlay
  const q = new URL(req.url).searchParams;
  const min = toMs(q.get("timeMin"));
  const max = toMs(q.get("timeMax"));
  if (min != null && max != null)
    return Response.json({ logs: listLogsRange(min, max) });
  return Response.json({ logs: listLogs() });
}

export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = (await req.json()) as Partial<LogDraft>;
  if (!body.kind) return Response.json({ detail: "kind required" }, { status: 400 });

  // start/end (editable in the preview) are the source of truth for the epochs.
  const draft: LogDraft = {
    kind: body.kind,
    title: body.title ?? null,
    note: body.note ?? null,
    start: body.start ?? null,
    end: body.end ?? null,
    startMs: toMs(body.start) ?? body.startMs ?? null,
    endMs: toMs(body.end) ?? body.endMs ?? null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    metrics:
      body.metrics && typeof body.metrics === "object" ? body.metrics : {},
    source: body.source ?? "manual",
    imagePath: safeImagePath(body.imagePath),
  };
  return Response.json(saveLog(draft));
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  softDeleteLog(id);
  return Response.json({ ok: true });
}
