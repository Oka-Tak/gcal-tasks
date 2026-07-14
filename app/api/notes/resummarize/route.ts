import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { bindNoteToFolder, folderOfNoteSync } from "@/lib/folder-notes";
import { notebookFor, summarizeAndPublish } from "@/lib/notes";

export const runtime = "nodejs";

/**
 * POST {id} — 要約だけ作り直す（文字起こしはそのまま）。
 * フォルダに後から置いた資料（OneDrive/Syncthing経由含む）を5分スキャンを
 * 待たずに反映したいとき用。フォルダ紐付きノートは台帳のファイル記録も
 * 更新するので、直後の定期スキャンが同じ再要約を二重に走らせない。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  const id = body?.id;
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });

  const r = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!r || r.deletedAt) return Response.json({ detail: "ノートが見つかりません" }, { status: 404 });
  if (r.status === "transcribing" || r.status === "summarizing")
    return Response.json({ detail: "処理中です（完了後にやり直せます）" }, { status: 409 });

  const dir = folderOfNoteSync(id);
  if (dir) await bindNoteToFolder(id, dir); // 資料の現状をスナップショット（スキャンとの二重実行防止）

  const nb = r.notebook ?? notebookFor(null, r.eventKey);
  void summarizeAndPublish(id, r.title ?? "(無題)", null, nb, r.transcript ?? "");
  return Response.json({ ok: true });
}
