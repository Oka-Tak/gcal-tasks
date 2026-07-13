import fs from "node:fs/promises";
import path from "node:path";
import { type NextRequest } from "next/server";
import { isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { courseView } from "@/lib/course-sessions";
import { createNoteForFolder, queueFolderNotes } from "@/lib/folder-notes";

export const runtime = "nodejs";

/**
 * ノート欄の授業ビュー。
 * GET            → { notebooks: [{folder, notebook, files, notes}] } 授業チップ用
 * GET ?course=X  → 回別ビュー（カレンダー由来の第N回 + フォルダ・ファイル・ノート対応）
 * POST {course, ymd}                → その回のフォルダからノートを即時作成
 * POST {course, ymd, prepare:true}  → その回のフォルダだけ作成（資料置き場の準備）
 * POST {course, bulk:true}          → 資料があるのにノートが無い回を一括キュー
 *                                     （5分毎スキャンが2件/回のペースで消化）
 */

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const root = env.notesExportDir;
  if (!root) return Response.json({ notebooks: [] });

  const course = req.nextUrl.searchParams.get("course");
  if (course) return Response.json(await courseView(path.basename(course)));

  // ノート数（notebook 単位）
  const noteCounts = new Map<string, number>();
  for (const r of db.select({ n: notes.notebook }).from(notes).where(isNull(notes.deletedAt)).all()) {
    if (r.n) noteCounts.set(r.n, (noteCounts.get(r.n) ?? 0) + 1);
  }

  const out: { folder: string; notebook: string; files: number; notes: number }[] = [];
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch { /* 共有未同期 */ }
  for (const d of dirs) {
    let files = 0;
    for await (const _ of walk(path.join(root, d))) files++;
    const notebook = `講義: ${d}`;
    out.push({ folder: d, notebook, files, notes: noteCounts.get(notebook) ?? 0 });
  }
  out.sort((a, b) => b.notes - a.notes || b.files - a.files);
  return Response.json({ notebooks: out });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const root = env.notesExportDir;
  if (!root) return Response.json({ detail: "KAIROS_NOTES_EXPORT 未設定" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as
    | { course?: string; ymd?: string; prepare?: boolean; bulk?: boolean }
    | null;
  const course = path.basename((body?.course ?? "").trim());
  if (!course) return Response.json({ detail: "course が必要です" }, { status: 400 });

  if (body?.bulk) {
    const view = await courseView(course);
    const rels = view.sessions
      .filter((s) => !s.future && s.folder && s.files.length > 0 && !s.noteId)
      .map((s) => path.join(course, s.folder!));
    const queued = await queueFolderNotes(rels);
    return Response.json({ queued });
  }

  const ymd = String(body?.ymd ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return Response.json({ detail: "ymd が必要です" }, { status: 400 });
  const view = await courseView(course);
  const s = view.sessions.find((x) => x.ymd === ymd);
  let folder = s?.folder ?? null;
  if (!folder) {
    folder = `${course}${ymd.replace(/-/g, "")}`;
    await fs.mkdir(path.join(root, course, folder), { recursive: true });
  }
  if (body?.prepare) return Response.json({ folder });
  try {
    const noteId = await createNoteForFolder(path.join(course, folder));
    return Response.json({ noteId });
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e) }, { status: 400 });
  }
}
