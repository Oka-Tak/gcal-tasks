import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { ingestAudioNote } from "@/lib/notes";
import { uploadSetError } from "@/lib/upload-limits";

export const runtime = "nodejs";

const MAX_BYTES = 500_000_000; // 500 MB — a 90-min lecture in m4a is ~80 MB
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 500_000_000;

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
  const uploadError = uploadSetError(files, { maxFiles: MAX_FILES, maxFileBytes: MAX_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
  if (uploadError) return Response.json({ detail: uploadError }, { status: 400 });

  try {
    const res = await ingestAudioNote({
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
    return Response.json(res); // {id, merged, title} — 合流時はUIが行き先を知らせる
  } catch (e) {
    return Response.json({ detail: String(e) }, { status: 400 });
  }
}
