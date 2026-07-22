import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { addMaterial } from "@/lib/materials";
import { bindNoteToFolder, folderOfNoteSync } from "@/lib/folder-notes";
import { eventStartMs, notebookFor, summarizeAndPublish } from "@/lib/notes";
import { dateFromTitle, resolveNoteDir } from "@/lib/notes-export";
import { uploadSetError } from "@/lib/upload-limits";

export const runtime = "nodejs";

// 録画入りpptxやスキャンPDFで100MB超は普通にあるので余裕を持たせる
// (テキスト抽出側は出力行数/文字数で上限管理しており入力サイズには耐性がある)
const MAX_BYTES = 300_000_000;
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 500_000_000;

/**
 * POST multipart {id, file×N} — 既存ノートに資料（pdf/pptx等）を後付けする。
 * ノートのフォルダに実体を置いてRAGにも登録し、ノートをフォルダに紐付けた上で
 * 資料テキスト込みで再要約する（文字起こしがあればそれも保持）。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });

  const form = await req.formData();
  const id = form.get("id");
  if (typeof id !== "string" || !id) return Response.json({ detail: "id required" }, { status: 400 });
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  const uploadError = uploadSetError(files, { maxFiles: MAX_FILES, maxFileBytes: MAX_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
  if (uploadError) return Response.json({ detail: uploadError }, { status: 400 });

  const r = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!r || r.deletedAt) return Response.json({ detail: "ノートが見つかりません" }, { status: 404 });
  const nb = r.notebook ?? notebookFor(null, r.eventKey);

  // 置き先: ノートに紐付いたフォルダ > 棚と講義日からの解決（無ければ data/materials）
  const dir =
    folderOfNoteSync(id) ??
    (await resolveNoteDir(nb, eventStartMs(r.eventKey) ?? dateFromTitle(r.title, r.createdAt)).catch(() => null));

  try {
    for (const f of files) {
      await addMaterial({
        buf: Buffer.from(await f.arrayBuffer()),
        filename: f.name || "material",
        notebook: nb,
        eventKey: r.eventKey,
        dir,
      });
    }
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e) }, { status: 400 });
  }

  // フォルダに置けた場合はノートを紐付けて資料込みで再要約（進行中なら走行中の
  // パイプラインが要約時に資料を拾うので触らない）
  let resummarize = false;
  if (dir) {
    const bound = await bindNoteToFolder(id, dir);
    if (bound && (r.status === "done" || r.status === "error")) {
      resummarize = true;
      void summarizeAndPublish(id, r.title ?? "(無題)", null, nb, r.transcript ?? "");
    }
  }
  return Response.json({ ok: true, added: files.length, resummarize });
}
