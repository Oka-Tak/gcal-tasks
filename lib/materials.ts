import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { materials, notes } from "./db/schema";
import { env } from "./env";
import { owuiSupportedExt, pushLocalFileToOwui, removeOwuiFile } from "./owui";
import { notebookFor } from "./notes";

/**
 * NotebookLM的な「ソース資料」: ノートブック（=OWUIコレクション）へ任意の
 * ファイルを追加/削除する。実体は data/materials/ に残し、RAG登録はOWUI。
 */

const SUBDIR = "materials";
const MAX_BYTES = 50_000_000;

export interface MaterialView {
  id: string;
  notebook: string;
  filename: string;
  size: number | null;
  inRag: boolean; // OWUI登録に成功しているか
  createdAt: number | null;
}

type Row = typeof materials.$inferSelect;
const view = (r: Row): MaterialView => ({
  id: r.id,
  notebook: r.notebook,
  filename: r.filename,
  size: r.size,
  inRag: !!r.owuiFileId,
  createdAt: r.createdAt,
});

export function listMaterials(notebook?: string | null): MaterialView[] {
  const rows = notebook
    ? db.select().from(materials).where(and(isNull(materials.deletedAt), eq(materials.notebook, notebook))).orderBy(desc(materials.createdAt)).all()
    : db.select().from(materials).where(isNull(materials.deletedAt)).orderBy(desc(materials.createdAt)).all();
  return rows.map(view);
}

/** ノートブック候補: 既存の資料・ノートの棚 + 既定。UIのdatalist用。 */
export function listNotebooks(): string[] {
  const set = new Set<string>(["Kairos ノート"]);
  for (const r of db.select({ n: materials.notebook }).from(materials).where(isNull(materials.deletedAt)).all()) set.add(r.n);
  for (const r of db.select({ n: notes.notebook }).from(notes).where(isNull(notes.deletedAt)).all()) if (r.n) set.add(r.n);
  return [...set].sort();
}

/** 資料を保存してOWUIコレクションへ登録。RAG登録失敗でもローカルには残す。 */
export async function addMaterial(opts: {
  buf: Buffer;
  filename: string;
  notebook?: string | null;
  eventKey?: string | null; // あれば「講義: <予定名>」の棚に入る
}): Promise<MaterialView> {
  const ext = (path.extname(opts.filename) || "").toLowerCase();
  if (!owuiSupportedExt(ext)) throw new Error(`未対応の形式です: ${ext || "(拡張子なし)"}（pdf/docx/pptx/xlsx/csv/txt/md/html）`);
  if (opts.buf.length === 0 || opts.buf.length > MAX_BYTES) throw new Error("ファイルが空か大きすぎます（50MBまで）");
  const notebook = notebookFor(opts.notebook, opts.eventKey) ?? "Kairos ノート";

  const dir = path.join(path.resolve(env.dataDir), SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const safeName = path.basename(opts.filename).replace(/[\\/]/g, "_");
  const abs = path.join(dir, `${id}-${safeName}`);
  await fs.writeFile(abs, opts.buf);

  let owuiFileId: string | null = null;
  try {
    owuiFileId = await pushLocalFileToOwui(opts.buf, safeName, notebook);
  } catch (e) {
    console.error("[materials] OWUI push failed (kept locally):", String(e).slice(0, 200));
  }

  const now = Date.now();
  const row: typeof materials.$inferInsert = {
    id, notebook, eventKey: opts.eventKey ?? null, filename: safeName,
    path: abs, size: opts.buf.length, owuiFileId, createdAt: now,
  };
  db.insert(materials).values(row).run();
  return view(row as Row);
}

export async function deleteMaterial(id: string): Promise<void> {
  const r = db.select().from(materials).where(eq(materials.id, id)).get();
  if (!r || r.deletedAt) return;
  if (r.owuiFileId) await removeOwuiFile(r.notebook, r.owuiFileId).catch(() => {});
  db.update(materials).set({ deletedAt: Date.now() }).where(eq(materials.id, id)).run();
  await fs.rm(r.path, { force: true }).catch(() => {});
}
