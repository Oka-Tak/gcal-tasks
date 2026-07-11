import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

/**
 * NotebookLM風のフォルダ還流: ノートの成果物（要約md + 全文文字起こしtxt）を
 * OneDrive ミラー（Syncthing 共有）内の「講義ノート/<授業名>/」へ書き出す。
 * Syncthing が Windows / OneDrive に運ぶので、フォルダ単位で他端末からも見える。
 *
 * 再エクスポート（タイトル編集等でファイル名が変わる）に備え、ノートごとの
 * 出力パスを data/notes-export.json に控えて古いファイルを消す。
 */

const MAP_FILE = () => path.join(path.resolve(env.dataDir), "notes-export.json");

type ExportMap = Record<string, string[]>; // noteId → 出力した絶対パス

async function loadMap(): Promise<ExportMap> {
  try {
    return JSON.parse(await fs.readFile(MAP_FILE(), "utf8"));
  } catch {
    return {};
  }
}

async function saveMap(m: ExportMap) {
  await fs.mkdir(path.dirname(MAP_FILE()), { recursive: true });
  await fs.writeFile(MAP_FILE(), JSON.stringify(m, null, 1));
}

/** Windows/OneDrive で通らない文字を落とす（両OSで安全なファイル名に）。 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "無題";
}

/** notebook（"講義: X" 等）→ フォルダ名。未分類は「その他」。 */
export function courseFolderOf(notebook: string | null | undefined): string {
  const n = (notebook ?? "").trim();
  return sanitize(n.replace(/^講義:\s*/, "") || "その他");
}

export interface ExportableNote {
  id: string;
  title: string | null;
  content: string | null;
  transcript: string | null;
  notebook: string | null;
  createdAt: number | null;
}

/**
 * ノートをフォルダへ書き出す（既存の書き出しは置き換え）。
 * エクスポート先が未設定/未同期なら黙って何もしない（ローカル完結は維持）。
 */
export async function exportNoteFiles(note: ExportableNote): Promise<void> {
  const root = env.notesExportDir;
  if (!root) return;
  try {
    // 共有ディレクトリ自体が消えている（Syncthing 未接続等）なら書かない —
    // 勝手に別物のツリーを生やして同期を汚さないため。
    await fs.access(path.dirname(root));
  } catch {
    console.log(`[notes-export] export root parent missing — skip: ${root}`);
    return;
  }

  const d = new Date(note.createdAt ?? Date.now());
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const base = `${stamp} ${sanitize(note.title ?? "無題")}`;
  const dir = path.join(root, courseFolderOf(note.notebook));
  await fs.mkdir(dir, { recursive: true });

  const map = await loadMap();
  const written: string[] = [];
  if (note.content?.trim()) {
    const p = path.join(dir, `${base}.md`);
    await fs.writeFile(p, `# ${note.title ?? "無題"}\n\n${note.content.trim()}\n`);
    written.push(p);
  }
  if (note.transcript?.trim()) {
    const p = path.join(dir, `${base}（全文文字起こし）.txt`);
    await fs.writeFile(p, note.transcript);
    written.push(p);
  }

  // 前回と違うパスに書いたら旧ファイルを掃除（タイトル・分類変更時）
  for (const old of map[note.id] ?? []) {
    if (!written.includes(old)) await fs.rm(old, { force: true }).catch(() => {});
  }
  if (written.length > 0) {
    map[note.id] = written;
    await saveMap(map);
    console.log(`[notes-export] ${written.length} file(s) → ${dir}`);
  }
}

/** ノート削除時: 書き出したファイルも消す（空になったフォルダは残す）。 */
export async function removeExportedFiles(noteId: string): Promise<void> {
  const map = await loadMap();
  const paths = map[noteId];
  if (!paths) return;
  for (const p of paths) await fs.rm(p, { force: true }).catch(() => {});
  delete map[noteId];
  await saveMap(map);
}
