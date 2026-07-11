import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { env } from "./env";

/**
 * NotebookLM風のフォルダ集約: ノートの成果物（要約md + 全文文字起こしtxt）を
 * OneDrive ミラー（Syncthing 共有）の授業資料フォルダへ書き出す。
 * 授業のpptx/pdfと同じ場所に置く＝「そのフォルダを見れば全部ある」状態にして、
 * Syncthing が Windows / OneDrive に運ぶ。
 *
 * 置き場所の解決:
 *   - notebook「講義: X」→ <授業資料>/X/、さらに講義日 YYYYMMDD を名前に含む
 *     回別サブフォルダ（例 AIシステムI/20260702, 地震防災20260711）があればそこ
 *   - その他の notebook X → 共有ルート直下に X/ が既にあればそこ（Cue-FM等）、
 *     なければ <共有ルート>/ノート/X/
 *   - 未分類 → <共有ルート>/ノート/その他/
 *
 * 再エクスポート（タイトル・分類編集でパスが変わる）に備え、ノートごとの
 * 出力パスを data/notes-export.json に控えて古いファイルを消す。
 * owui-sync はこの台帳にあるパスをスキップする（ノート本文は pushNoteToOwui が
 * 直接OWUIへ登録済みのため、拾うと二重インデックスになる）。
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

/**
 * OneDrive(Windows)を往復したフォルダは読み取り専用属性が付いて戻ってくる
 * ことがある(Syncthing ignorePerms=false) — 消せない時は親に書き込み権限を
 * 足して再試行する。
 */
async function rmForce(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch {
    await fs.chmod(path.dirname(p), 0o755).catch(() => {});
    await fs.rm(p, { force: true }).catch(() => {});
  }
}

async function mkdirForce(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EACCES") throw e;
    await fs.chmod(path.dirname(dir), 0o755);
    await fs.mkdir(dir, { recursive: true });
  }
}

/** owui-sync 用: エクスポート済みファイルの絶対パス集合。 */
export function exportedPathsSync(): Set<string> {
  try {
    const m = JSON.parse(fsSync.readFileSync(MAP_FILE(), "utf8")) as ExportMap;
    return new Set(Object.values(m).flat());
  } catch {
    return new Set();
  }
}

/** Windows/OneDrive で通らない文字を落とす（両OSで安全なファイル名に）。 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "無題";
}

async function dirNames(parent: string): Promise<string[]> {
  try {
    return (await fs.readdir(parent, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 授業名 → 授業資料内の既存フォルダ名。表記ゆれ（AIシステム/AIシステムI等）は
 * 片方がもう片方を含むなら同一とみなす（最長一致を採用）。無ければ授業名のまま。
 */
async function matchCourseDir(coursesRoot: string, course: string): Promise<string> {
  const dirs = await dirNames(coursesRoot);
  if (dirs.includes(course)) return course;
  const hits = dirs.filter((d) => d.includes(course) || course.includes(d));
  if (hits.length > 0) return hits.sort((a, b) => b.length - a.length)[0];
  return course;
}

/**
 * 回別サブフォルダ「<授業名><YYYYMMDD>」(例: 多変量解析20260630)。
 * 講義日を名前に含む既存フォルダがあればそこ、なければ作成する。
 */
async function sessionDirOf(courseAbs: string, dateMs: number | null): Promise<string> {
  if (!dateMs) return courseAbs;
  const d = new Date(dateMs);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  // 既存の回別フォルダは授業によって 20260421 / 260421(YYMMDD) / 0421 と揺れる
  const hit = (await dirNames(courseAbs)).find(
    (n) => n.includes(ymd) || n.includes(ymd.slice(2)) || /^\D*\d{4}\D*$/.test(n) && n.includes(ymd.slice(4)),
  );
  if (hit) return path.join(courseAbs, hit);
  const dir = path.join(courseAbs, `${path.basename(courseAbs)}${ymd}`);
  await mkdirForce(dir);
  return dir;
}

/**
 * タイトルから講義日を拾う（「AIシステムI 0702」「狩野研 7/2」等）。
 * 予定に紐付いていないノートの回別フォルダ推定用。年は基準日から補完。
 */
export function dateFromTitle(title: string | null | undefined, baseMs: number | null): number | null {
  if (!title) return null;
  const base = new Date(baseMs ?? Date.now());
  const m8 = title.match(/(20\d{2})(\d{2})(\d{2})(?!\d)/); // YYYYMMDD
  if (m8) {
    const t = new Date(+m8[1], +m8[2] - 1, +m8[3]);
    if (+m8[2] >= 1 && +m8[2] <= 12) return t.getTime();
  }
  const m4 = title.match(/(?:^|\D)(\d{2})(\d{2})(?!\d)/); // MMDD
  if (m4 && +m4[1] >= 1 && +m4[1] <= 12 && +m4[2] >= 1 && +m4[2] <= 31) {
    return new Date(base.getFullYear(), +m4[1] - 1, +m4[2]).getTime();
  }
  const mSlash = title.match(/(?:^|\D)(\d{1,2})[/_](\d{1,2})(?!\d)/); // M/D (sanitize後は M_D)
  if (mSlash && +mSlash[1] >= 1 && +mSlash[1] <= 12 && +mSlash[2] >= 1 && +mSlash[2] <= 31) {
    return new Date(base.getFullYear(), +mSlash[1] - 1, +mSlash[2]).getTime();
  }
  return null;
}

/**
 * ノートの置き場所（絶対パス）を解決する。エクスポート先未設定なら null。
 * addMaterial（資料アップロード）も同じ解決を使い、資料とノートを同じ棚に置く。
 */
export async function resolveNoteDir(
  notebook: string | null | undefined,
  lectureDateMs: number | null,
): Promise<string | null> {
  const coursesRoot = env.notesExportDir; // …/授業資料
  if (!coursesRoot) return null;
  try {
    await fs.access(coursesRoot); // 共有が未同期なら書かない（勝手にツリーを生やさない）
  } catch {
    return null;
  }
  const shareRoot = path.dirname(coursesRoot);
  const n = (notebook ?? "").trim();

  if (n.startsWith("講義:")) {
    const course = sanitize(n.replace(/^講義:\s*/, ""));
    const dir = path.join(coursesRoot, await matchCourseDir(coursesRoot, course));
    await mkdirForce(dir);
    return sessionDirOf(dir, lectureDateMs);
  }
  if (n) {
    const name = sanitize(n);
    const top = path.join(shareRoot, name);
    try {
      if ((await fs.stat(top)).isDirectory()) return top; // 既存のトップフォルダ（Cue-FM等）
    } catch { /* fall through */ }
    const dir = path.join(shareRoot, "ノート", name);
    await mkdirForce(dir);
    return dir;
  }
  const dir = path.join(shareRoot, "ノート", "その他");
  await mkdirForce(dir);
  return dir;
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
 * lectureDateMs = 講義日（予定の開始時刻）。無ければ作成日で回別フォルダを探す。
 */
export async function exportNoteFiles(note: ExportableNote, lectureDateMs?: number | null): Promise<void> {
  // 講義日: 予定の開始日 > タイトル中の日付(0703, 7/2等) > ノート作成日
  const dateMs = lectureDateMs ?? dateFromTitle(note.title, note.createdAt) ?? note.createdAt;
  const dir = await resolveNoteDir(note.notebook, dateMs);
  if (!dir) return;

  const d = new Date(dateMs ?? Date.now());
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const base = `${stamp} ${sanitize(note.title ?? "無題")}`;

  // Windowsの「読み取り専用」属性が同期されて書けないフォルダがある
  // (Syncthing ignorePerms=false) — 一度だけ権限を足して再試行する。
  const write = async (p: string, body: string) => {
    try {
      await fs.writeFile(p, body);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EACCES") throw e;
      await fs.chmod(path.dirname(p), 0o755);
      await fs.writeFile(p, body);
    }
  };

  const map = await loadMap();
  const written: string[] = [];
  if (note.content?.trim()) {
    const p = path.join(dir, `${base}.md`);
    await write(p, `# ${note.title ?? "無題"}\n\n${note.content.trim()}\n`);
    written.push(p);
  }
  if (note.transcript?.trim()) {
    const p = path.join(dir, `${base}（全文文字起こし）.txt`);
    await write(p, note.transcript);
    written.push(p);
  }

  // 前回と違うパスに書いたら旧ファイルを掃除（タイトル・分類変更時）
  for (const old of map[note.id] ?? []) {
    if (!written.includes(old)) await rmForce(old);
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
  for (const p of paths) await rmForce(p);
  delete map[noteId];
  await saveMap(map);
}
