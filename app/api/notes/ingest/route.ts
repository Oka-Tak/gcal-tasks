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
 * Upload audio file(s) — 複数で1セット（前半/後半、講義+英語上映など）。
 * "file" と "language" を同じ順で複数 append する（language は ja/en/auto…）。
 * Returns immediately with the note id; the client polls /api/notes?id=.
 */
export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });

  const form = await req.formData();
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  const langs = form.getAll("language").map((l) => (typeof l === "string" ? l : ""));
  if (files.length === 0)
    return Response.json({ detail: "file required" }, { status: 400 });
  if (files.some((f) => f.size === 0 || f.size > MAX_BYTES))
    return Response.json({ detail: "file empty or too large" }, { status: 400 });

  try {
    const id = await ingestAudioNote({
      files: await Promise.all(
        files.map(async (f, i) => ({
          buf: Buffer.from(await f.arrayBuffer()),
          filename: f.name || "audio",
          language: langs[i] || null,
        })),
      ),
      title: (form.get("title") as string) || files[0].name || "音声ノート",
      eventKey: (form.get("eventKey") as string) || null,
      eventLabel: (form.get("eventLabel") as string) || null,
      notebook: (form.get("notebook") as string) || null,
    });
    return Response.json({ id });
  } catch (e) {
    return Response.json({ detail: String(e) }, { status: 400 });
  }
}
