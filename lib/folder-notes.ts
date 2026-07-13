import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { notes } from "./db/schema";
import { env } from "./env";
import { AUDIO_EXT, addAudiosToNote, inFlightCount, summarizeAndPublish, type AudioSource } from "./notes";
import { exportedPathsSync } from "./notes-export";
import { dateFromFolderName, occurrenceForDate } from "./course-sessions";

/**
 * フォルダ駆動ノート: 授業資料/<授業>/<フォルダ>/ を定期スキャンして、
 *  - 新しいフォルダにファイルが置かれたら → その資料・音声からノートを自動生成
 *  - 既存フォルダに音声が増えたら → ノートに音源追加（文字起こし→再要約）
 *  - 資料(pdf/pptx等)が増減・更新されたら → 資料テキストを取り直して再要約
 * Syncthing経由でWindows側からファイルを置くだけでノートが育つ。
 *
 * 台帳 data/folder-notes.json: フォルダ相対パス → { noteId, files }。
 * 初回スキャンは既存フォルダを「基準」として記録するだけ（過去分を一斉に
 * ノート化してwhisperx/エージェントを飽和させない）。以降の差分だけが動く。
 * Kairos自身が書き出すノートmd/全文txt（notes-export.json台帳）は資料として
 * 数えない — 数えると自分の出力に反応する無限ループになる。
 * 再要約はソースからの再生成なので、ノート本文の手動編集は上書きされる。
 */

const LEDGER = () => path.join(path.resolve(env.dataDir), "folder-notes.json");
const MATERIAL_EXT = new Set([".pdf", ".pptx", ".docx", ".xlsx", ".csv", ".md", ".txt"]);
const SELF_EXTRACT = new Set([".pdf", ".pptx", ".xlsx", ".csv"]); // extract-text.py対応形式
const EXTRACT_PY = path.join(process.cwd(), "scripts", "extract-text.py");
const EXTRACT_PYTHON =
  process.env.KAIROS_EXTRACT_PYTHON ??
  path.join(os.homedir(), ".local", "share", "uv", "tools", "open-webui", "bin", "python");
// 書き込み途中（Syncthing転送中・録音コピー中）に反応しない: 最終更新から
// この時間静かになったフォルダだけ処理する
const SETTLE_MS = Number(process.env.KAIROS_FOLDER_SETTLE_MS ?? 2 * 60_000);
const TICK_MS = Number(process.env.KAIROS_FOLDER_TICK_MS ?? 5 * 60_000);
const MAX_ACTIONS_PER_TICK = 2; // whisperx/エージェント起動を1tick2件までに絞る
const MAX_AUDIO_BYTES = 300_000_000;

interface FileStamp { mtimeMs: number; size: number }
interface FolderEntry { noteId: string | null; files: Record<string, FileStamp> }
interface Ledger { folders: Record<string, FolderEntry> }

async function loadLedger(): Promise<Ledger> {
  try {
    const j = JSON.parse(await fs.readFile(LEDGER(), "utf8")) as Ledger;
    return { folders: j.folders ?? {} };
  } catch {
    return { folders: {} };
  }
}

async function saveLedger(l: Ledger): Promise<void> {
  await fs.mkdir(path.dirname(LEDGER()), { recursive: true });
  await fs.writeFile(LEDGER(), JSON.stringify(l, null, 1));
}

function extractText(abs: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      EXTRACT_PYTHON,
      [EXTRACT_PY, abs],
      { maxBuffer: 8_000_000, timeout: 120_000 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/** 授業資料直下の授業フォルダ（過年度 20XX は除く）の下の回別フォルダ一覧。 */
async function listFolders(root: string): Promise<{ rel: string; abs: string; course: string }[]> {
  const out: { rel: string; abs: string; course: string }[] = [];
  let courses: fsSync.Dirent[];
  try {
    courses = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const c of courses) {
    if (!c.isDirectory() || c.name.startsWith(".") || /^20\d\d$/.test(c.name)) continue;
    const cAbs = path.join(root, c.name);
    let subs: fsSync.Dirent[];
    try {
      subs = await fs.readdir(cAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subs) {
      if (!s.isDirectory() || s.name.startsWith(".")) continue;
      out.push({ rel: path.join(c.name, s.name), abs: path.join(cAbs, s.name), course: c.name });
    }
  }
  return out;
}

interface FolderFiles {
  audio: string[];
  materials: string[];
  stamps: Record<string, FileStamp>;
  settling: boolean; // 書き込み後 SETTLE_MS 以内のファイルがある
}

async function collectFiles(abs: string, exported: Set<string>): Promise<FolderFiles> {
  const out: FolderFiles = { audio: [], materials: [], stamps: {}, settling: false };
  let ents: fsSync.Dirent[];
  try {
    ents = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const e of ents) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const ext = path.extname(e.name).toLowerCase();
    const isAudio = AUDIO_EXT.has(ext);
    if (!isAudio && !MATERIAL_EXT.has(ext)) continue;
    const p = path.join(abs, e.name);
    if (exported.has(p)) continue; // Kairos自身のノート成果物は素材ではない
    const st = await fs.stat(p).catch(() => null);
    if (!st || st.size === 0) continue;
    if (now - st.mtimeMs < SETTLE_MS) out.settling = true;
    out.stamps[e.name] = { mtimeMs: st.mtimeMs, size: st.size };
    (isAudio ? out.audio : out.materials).push(e.name);
  }
  return out;
}

/**
 * フォルダに既にノートが書き出されていれば、そのノートに紐付ける
 * （UI経由で作った既存ノートを乗っ取らず育てるため）。notes-export.json の逆引き。
 */
function linkedNoteId(folderAbs: string): string | null {
  try {
    const m = JSON.parse(
      fsSync.readFileSync(path.join(path.resolve(env.dataDir), "notes-export.json"), "utf8"),
    ) as Record<string, string[]>;
    for (const [noteId, paths] of Object.entries(m)) {
      if (!paths.some((p) => path.dirname(p) === folderAbs)) continue;
      const r = db.select().from(notes).where(eq(notes.id, noteId)).get();
      if (r && !r.deletedAt) return noteId;
    }
  } catch { /* 台帳なし */ }
  return null;
}

async function readAudioSources(abs: string, names: string[]): Promise<AudioSource[]> {
  const out: AudioSource[] = [];
  for (const n of [...names].sort()) {
    const p = path.join(abs, n);
    const st = await fs.stat(p).catch(() => null);
    if (!st || st.size === 0 || st.size > MAX_AUDIO_BYTES) {
      console.log(`[folder-notes] skip audio (size) ${n}`);
      continue;
    }
    out.push({ buf: await fs.readFile(p), filename: n, language: "ja" });
  }
  return out;
}

const changed = (a: FileStamp | undefined, b: FileStamp | undefined) =>
  !a || !b || a.mtimeMs !== b.mtimeMs || a.size !== b.size;

/**
 * フォルダからノートを作る共通部（スキャンの新フォルダ検出と「この回のノートを
 * 作成」ボタンの両方）。フォルダ名の日付がカレンダーの開催日に一致すれば
 * 予定に紐付け、タイトルを「<授業> 第N回 (M/D)」にする。
 */
async function createNote(ledger: Ledger, rel: string, abs: string, course: string, cur: FolderFiles): Promise<string> {
  const id = crypto.randomUUID();
  const dirName = path.basename(abs);
  const dateMs = dateFromFolderName(dirName);
  const occ = dateMs ? occurrenceForDate(course, dateMs) : null;
  const title = occ
    ? `${course} 第${occ.n}回 (${new Date(occ.dateMs).getMonth() + 1}/${new Date(occ.dateMs).getDate()})`
    : dirName;
  const notebook = `講義: ${course}`;
  const now = Date.now();
  db.insert(notes)
    .values({
      id, title, notebook, eventKey: occ?.eventKey ?? null,
      status: cur.audio.length ? "transcribing" : "summarizing",
      createdAt: now, updatedAt: now,
    })
    .run();
  const entry = (ledger.folders[rel] ??= { noteId: null, files: {} });
  entry.noteId = id;
  entry.files = cur.stamps;
  await saveLedger(ledger); // 要約側が folderMaterialsText で参照するので先に確定
  const srcs = cur.audio.length ? await readAudioSources(abs, cur.audio) : [];
  if (srcs.length) await addAudiosToNote(id, srcs);
  else void summarizeAndPublish(id, title, null, notebook, "");
  console.log(`[folder-notes] ${rel}: ノート作成「${title}」(音源${srcs.length} 資料${cur.materials.length})`);
  return id;
}

/** UIの「この回のノートを作成」— 対象フォルダから即時にノートを作る。 */
export async function createNoteForFolder(rel: string): Promise<string> {
  const root = env.notesExportDir;
  if (!root) throw new Error("KAIROS_NOTES_EXPORT 未設定");
  const abs = path.join(root, rel);
  if (!fsSync.existsSync(abs)) throw new Error("フォルダがありません");
  const ledger = await loadLedger();
  const existing = ledger.folders[rel];
  if (existing?.noteId) {
    const r = db.select().from(notes).where(eq(notes.id, existing.noteId)).get();
    if (r && !r.deletedAt) throw new Error("このフォルダには既にノートがあります");
  }
  const cur = await collectFiles(abs, exportedPathsSync());
  if (cur.audio.length === 0 && cur.materials.length === 0)
    throw new Error("フォルダに資料・音声がありません");
  return createNote(ledger, rel, abs, rel.split(path.sep)[0], cur);
}

/**
 * 一括作成キュー: 台帳のfilesを空に戻すと、次回以降のスキャンが「新規ファイル」
 * として拾い、1tick2件のペースでノート化していく（whisperx/エージェントの
 * 飽和とquota消費を抑えるため即時全実行はしない）。
 */
export async function queueFolderNotes(rels: string[]): Promise<number> {
  const ledger = await loadLedger();
  let n = 0;
  for (const rel of rels) {
    const entry = (ledger.folders[rel] ??= { noteId: null, files: {} });
    if (entry.noteId) continue;
    entry.files = {};
    n++;
  }
  if (n) await saveLedger(ledger);
  return n;
}

/**
 * 既存ノートをフォルダに紐付ける（ノートへの資料追加時）。以後そのフォルダの
 * ファイル増減がこのノートを更新し、資料テキストが要約に入る。files は現状で
 * スナップショットするので、直後の手動再要約と定期スキャンが二重に走らない。
 */
export async function bindNoteToFolder(noteId: string, folderAbs: string): Promise<boolean> {
  const root = env.notesExportDir;
  if (!root) return false;
  const rel = path.relative(root, folderAbs);
  if (rel.startsWith("..") || !rel) return false; // 授業資料の外（data/materials等）は対象外
  const ledger = await loadLedger();
  const entry = (ledger.folders[rel] ??= { noteId: null, files: {} });
  if (!entry.noteId) entry.noteId = noteId;
  entry.files = (await collectFiles(folderAbs, exportedPathsSync())).stamps;
  await saveLedger(ledger);
  return entry.noteId === noteId;
}

/**
 * 整理スクリプト等がフォルダ内容を並べ替えた後に呼ぶ: 台帳のfilesを現状に
 * 合わせて記録し直し、次のスキャンが移動を「新規ファイル」と誤検出して
 * 一斉ノート生成しないようにする。
 */
export async function baselineFolders(rels: string[]): Promise<void> {
  const root = env.notesExportDir;
  if (!root) return;
  const ledger = await loadLedger();
  const exported = exportedPathsSync();
  for (const rel of rels) {
    const entry = (ledger.folders[rel] ??= { noteId: null, files: {} });
    entry.files = (await collectFiles(path.join(root, rel), exported)).stamps;
  }
  await saveLedger(ledger);
}

/**
 * ノート一覧カード用: noteId → {sources: フォルダ内の資料+音源数, folder: 相対パス}。
 * NotebookLM的な「ソースN個」表示のため。未紐付けノートは載らない。
 */
export async function noteSourceCounts(): Promise<Record<string, { sources: number; folder: string }>> {
  const root = env.notesExportDir;
  const out: Record<string, { sources: number; folder: string }> = {};
  if (!root) return out;
  const ledger = await loadLedger();
  const exported = exportedPathsSync();
  for (const [rel, e] of Object.entries(ledger.folders)) {
    if (!e.noteId || out[e.noteId]) continue;
    const cur = await collectFiles(path.join(root, rel), exported);
    out[e.noteId] = { sources: cur.audio.length + cur.materials.length, folder: rel };
  }
  return out;
}

/** ノートに紐付いたフォルダの絶対パス（未紐付けは null）。資料追加の置き先解決用。 */
export function folderOfNoteSync(noteId: string): string | null {
  const root = env.notesExportDir;
  if (!root) return null;
  try {
    const led = JSON.parse(fsSync.readFileSync(LEDGER(), "utf8")) as Ledger;
    const rel = Object.keys(led.folders ?? {}).find((k) => led.folders[k].noteId === noteId);
    return rel ? path.join(root, rel) : null;
  } catch {
    return null;
  }
}

/** 1周スキャン。実行したアクション数を返す（テスト・手動実行用にexport）。 */
export async function scanFolderNotes(): Promise<number> {
  const root = env.notesExportDir;
  if (!root || !fsSync.existsSync(root)) return 0;
  if (inFlightCount() > 0) return 0; // 文字起こし中はCPU競合を避けて次回へ

  const bootstrap = !fsSync.existsSync(LEDGER());
  const ledger = await loadLedger();
  const exported = exportedPathsSync();
  let actions = 0;

  for (const { rel, abs, course } of await listFolders(root)) {
    const cur = await collectFiles(abs, exported);
    if (cur.settling) continue; // まだ書き込み中 — 次のtickで
    let entry = ledger.folders[rel];
    if (!entry) {
      // 初見フォルダ: 初回スキャンでは中身ごと基準記録（過去分をノート化しない）。
      // 以降の初見は空記録にして、下の差分検出でノート化する。
      entry = ledger.folders[rel] = { noteId: linkedNoteId(abs), files: bootstrap ? cur.stamps : {} };
    }

    const newAudio = cur.audio.filter((n) => !entry.files[n]);
    const matChanged =
      cur.materials.some((n) => changed(entry.files[n], cur.stamps[n])) ||
      Object.keys(entry.files).some((n) => MATERIAL_EXT.has(path.extname(n).toLowerCase()) && !cur.stamps[n]);
    if (newAudio.length === 0 && !matChanged) continue;
    if (actions >= MAX_ACTIONS_PER_TICK) continue; // 残りは次のtickで

    // フォルダ⇔ノートは1対1: このフォルダに書き出し済みのノートが居れば
    // （UI経由の録音ノート等）、新規作成せずそれを採用して育てる
    if (!entry.noteId) entry.noteId = linkedNoteId(abs);

    if (!entry.noteId) {
      // フォルダにソースが現れた → ノート新規作成（音声があれば文字起こしから）
      await createNote(ledger, rel, abs, course, cur);
      actions++;
      continue;
    }

    const r = db.select().from(notes).where(eq(notes.id, entry.noteId)).get();
    if (!r || r.deletedAt) {
      entry.files = cur.stamps; // ユーザーが消したノートは復活させない
      continue;
    }
    if (newAudio.length > 0) {
      const srcs = await readAudioSources(abs, newAudio);
      if (srcs.length) await addAudiosToNote(entry.noteId, srcs); // 再要約は資料込みで走る
      console.log(`[folder-notes] ${rel}: 音源+${srcs.length} → 文字起こし・更新`);
    } else {
      console.log(`[folder-notes] ${rel}: 資料変更 → 再要約`);
      void summarizeAndPublish(entry.noteId, r.title ?? path.basename(abs), null, r.notebook, r.transcript ?? "");
    }
    entry.files = cur.stamps;
    actions++;
  }

  // ミラーから消えたフォルダは台帳からも落とす（ノート自体は残す）
  for (const rel of Object.keys(ledger.folders)) {
    if (!fsSync.existsSync(path.join(root, rel))) delete ledger.folders[rel];
  }
  await saveLedger(ledger);
  if (bootstrap)
    console.log(`[folder-notes] 基準記録: ${Object.keys(ledger.folders).length} フォルダ（既存分はノート化しない）`);
  return actions;
}

/**
 * ノートに紐付いたフォルダの配布資料テキスト（要約プロンプト用）。
 * pdf/pptx/xlsx/csv は extract-text.py、md/txt は生読み。.docx は抽出手段が
 * 無いので飛ばす（RAG側ではOWUIが拾う）。フォルダ紐付きでなければ null。
 */
export async function folderMaterialsText(noteId: string): Promise<string | null> {
  const root = env.notesExportDir;
  if (!root) return null;
  const ledger = await loadLedger();
  const rel = Object.keys(ledger.folders).find((k) => ledger.folders[k].noteId === noteId);
  if (!rel) return null;
  const abs = path.join(root, rel);
  const cur = await collectFiles(abs, exportedPathsSync());
  const parts: string[] = [];
  let total = 0;
  for (const name of cur.materials.sort()) {
    const ext = path.extname(name).toLowerCase();
    const p = path.join(abs, name);
    let text: string | null = null;
    if (SELF_EXTRACT.has(ext)) text = await extractText(p);
    else if (ext === ".md" || ext === ".txt") text = await fs.readFile(p, "utf8").catch(() => null);
    else continue;
    if (!text?.trim()) continue;
    const chunk = `--- 資料: ${name} ---\n${text.trim().slice(0, 30_000)}`;
    parts.push(chunk);
    total += chunk.length;
    if (total > 60_000) break;
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Started once per server process from instrumentation.ts. */
export function startFolderNotesLoop(): void {
  if (!env.notesExportDir) {
    console.log("[folder-notes] KAIROS_NOTES_EXPORT 未設定 — folder loop off");
    return;
  }
  const g = globalThis as unknown as { __kairosFolderNotesLoop?: ReturnType<typeof setInterval> };
  if (g.__kairosFolderNotesLoop) return; // survive dev HMR re-registration
  const tick = () =>
    scanFolderNotes()
      .then((n) => { if (n) console.log(`[folder-notes] actions: ${n}`); })
      .catch((e) => console.error("[folder-notes] tick failed:", e));
  const first = setTimeout(tick, 90_000); // 起動直後の同期・ノート復元が済んでから
  first.unref?.();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  g.__kairosFolderNotesLoop = timer;
  console.log(`[folder-notes] loop started (${Math.round(TICK_MS / 60_000)}min tick)`);
}
