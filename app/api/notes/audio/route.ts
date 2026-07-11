import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { addAudiosToNote } from "@/lib/notes";

export const runtime = "nodejs";

const MAX_BYTES = 500_000_000;

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
  if (files.length === 0) return Response.json({ detail: "file required" }, { status: 400 });
  if (files.some((f) => f.size === 0 || f.size > MAX_BYTES))
    return Response.json({ detail: "file empty or too large" }, { status: 400 });

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
