import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { ingestAudioNote } from "@/lib/notes";

export const runtime = "nodejs";

const MAX_BYTES = 500_000_000; // 500 MB — a 90-min lecture in m4a is ~80 MB

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/**
 * Upload an audio file and start the transcribe→summarize pipeline.
 * Returns immediately with the note id; the client polls /api/notes?id=.
 */
export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    return Response.json({ detail: "file required" }, { status: 400 });
  if (file.size === 0 || file.size > MAX_BYTES)
    return Response.json({ detail: "file empty or too large" }, { status: 400 });

  try {
    const id = await ingestAudioNote({
      buf: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "audio",
      title: (form.get("title") as string) || file.name || "音声ノート",
      eventKey: (form.get("eventKey") as string) || null,
      eventLabel: (form.get("eventLabel") as string) || null,
    });
    return Response.json({ id });
  } catch (e) {
    return Response.json({ detail: String(e) }, { status: 400 });
  }
}
