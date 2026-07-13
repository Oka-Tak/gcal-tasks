import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { createManualNote, getNote, listNotes, softDeleteNote, updateNote } from "@/lib/notes";
import { noteSourceCounts } from "@/lib/folder-notes";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** ?id= → one note (with content); ?eventKey= → that event's notes; none → all. */
export async function GET(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  if (id) {
    const note = getNote(id);
    return note
      ? Response.json({ note })
      : Response.json({ detail: "not found" }, { status: 404 });
  }
  // NotebookLM風カード用: 紐付いたフォルダのソース数（資料+音源）とフォルダ名を添える
  const counts = await noteSourceCounts().catch(() => ({}) as Awaited<ReturnType<typeof noteSourceCounts>>);
  const notes = listNotes(q.get("eventKey")).map((n) => ({
    ...n,
    sources: counts[n.id]?.sources ?? n.audios.length,
    folder: counts[n.id]?.folder ?? null,
  }));
  return Response.json({ notes });
}

/** Create a manual (no-audio) note. Audio goes to /api/notes/ingest. */
export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  if (!body.title) return Response.json({ detail: "title required" }, { status: 400 });
  const id = createManualNote({
    title: String(body.title),
    content: typeof body.content === "string" ? body.content : "",
    eventKey: typeof body.eventKey === "string" ? body.eventKey : null,
  });
  return Response.json({ id });
}

export async function PATCH(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  if (!body.id) return Response.json({ detail: "id required" }, { status: 400 });
  const patch: { title?: string; content?: string } = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.content === "string") patch.content = body.content;
  updateNote(String(body.id), patch);
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  softDeleteNote(id);
  return Response.json({ ok: true });
}
