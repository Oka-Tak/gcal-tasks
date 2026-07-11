import fs from "node:fs/promises";
import path from "node:path";
import { type NextRequest } from "next/server";
import { isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { notes } from "@/lib/db/schema";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * 授業フォルダ（OneDrive: 授業資料/<授業>）をノート欄のベースとして一覧する。
 * GET             → { notebooks: [{folder, notebook, files, notes}] }
 * GET ?folder=X   → { files: [{name, sub, size, mtimeMs}] } （そのフォルダの中身）
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

  const folder = req.nextUrl.searchParams.get("folder");
  if (folder) {
    // フォルダの中身（1授業分）。パストラバーサル防止に名前だけ受ける。
    const dir = path.join(root, path.basename(folder));
    const files: { name: string; sub: string; size: number; mtimeMs: number }[] = [];
    for await (const f of walk(dir)) {
      const st = await fs.stat(f).catch(() => null);
      if (!st) continue;
      const rel = path.relative(dir, f);
      files.push({
        name: path.basename(f),
        sub: path.dirname(rel) === "." ? "" : path.dirname(rel),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return Response.json({ files: files.slice(0, 500) });
  }

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
