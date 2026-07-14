import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { addAudiosToNote } from "@/lib/notes";
import { uploadSetError } from "@/lib/upload-limits";

export const runtime = "nodejs";

const MAX_BYTES = 500_000_000;
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 500_000_000;

/**
 * POST multipart {id, file×N, language×N} — 既存ノートに音源を追加する。
 * 追加分を文字起こしして全音源を結合し直し、要約も作り直す。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });

  const form = await req.formData();
  const id = form.get("id");
  if (typeof id !== "string" || !id) return Response.json({ detail: "id required" }, { status: 400 });
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  const langs = form.getAll("language").map((l) => (typeof l === "string" ? l : ""));
  const uploadError = uploadSetError(files, { maxFiles: MAX_FILES, maxFileBytes: MAX_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
  if (uploadError) return Response.json({ detail: uploadError }, { status: 400 });

  try {
    const ok = await addAudiosToNote(
      id,
      await Promise.all(
        files.map(async (f, i) => ({
          buf: Buffer.from(await f.arrayBuffer()),
          filename: f.name || "audio",
          language: langs[i] || null,
        })),
      ),
    );
    if (!ok) return Response.json({ detail: "ノートが見つかりません" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ detail: String(e) }, { status: 400 });
  }
}
