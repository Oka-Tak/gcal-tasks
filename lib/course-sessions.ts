import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { asc, isNull } from "drizzle-orm";
import { db } from "./db";
import { events, notes } from "./db/schema";
import { env } from "./env";

/**
 * カレンダー（eventsテーブル、4月からの実績あり）から授業の「第N回⇔日付」を
 * 導出する。第N回 = その授業のcancelled以外のN番目の開催日（休講はカレンダー
 * から消えている前提なので、実際に開催された順番がそのまま回数になる）。
 * 回別フォルダ（<授業名>YYYYMMDD / YYMMDD / MMDD 命名）・ノート
 * （folder-notes台帳 → notes-export逆引き）との対応付けもここで行い、
 * ノート欄の授業ビュー（/api/notebooks?course=X）の土台になる。
 */

const pad = (x: number) => String(x).padStart(2, "0");
const ymdOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 予定名⇔授業フォルダ名の表記ゆれは包含一致（「情報システム基礎演習 (3-4限)」⊃「情報システム基礎演習」）。 */
function courseMatches(summary: string | null, course: string): boolean {
  const s = (summary ?? "").trim();
  return !!s && (s.includes(course) || course.includes(s));
}

export interface Occurrence {
  n: number; // 第N回
  ymd: string; // "2026-04-14"
  dateMs: number;
  eventKey: string; // account|calendarId|googleId
}

/** 授業のカレンダー開催実績（同日複数コマは1回に統合）→ 第N回リスト。 */
export function courseOccurrences(course: string): Occurrence[] {
  const rows = db
    .select()
    .from(events)
    .where(isNull(events.deletedAt))
    .orderBy(asc(events.startMs))
    .all()
    .filter((e) => e.status !== "cancelled" && e.startMs != null && courseMatches(e.summary, course));
  const byDay = new Map<string, (typeof rows)[0]>();
  for (const e of rows) {
    const k = ymdOf(e.startMs!);
    if (!byDay.has(k)) byDay.set(k, e);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ymd, e], i) => ({
      n: i + 1,
      ymd,
      dateMs: e.startMs!,
      eventKey: `${e.account}|${e.calendarId}|${e.googleId}`,
    }));
}

/**
 * 回別フォルダ名がこの開催日を指すか（20260421 / 260421 / 0421 の3流派対応）。
 * 「drive-download-20260610T012505Z」のようなISOタイムスタンプは回別フォルダ
 * ではないので、日付の直後にT+数字が続くものは除外する。
 */
export function sessionDirMatches(dirName: string, ymd: string): boolean {
  const compact = ymd.replace(/-/g, ""); // 20260421
  const hit = (s: string) => new RegExp(`(?<!\\d)${s}(?![0-9T])`).test(dirName);
  return (
    hit(compact) ||
    hit(compact.slice(2)) ||
    (/^\D*\d{4}\D*$/.test(dirName) && dirName.includes(compact.slice(4)))
  );
}

/** フォルダ名から日付を推定（カレンダーに無い回のフォールバック表示用）。 */
export function dateFromFolderName(name: string): number | null {
  let m = name.match(/(20\d{2})(\d{2})(\d{2})(?![0-9T])/); // 20260421 (タイムスタンプ除外)
  if (m && +m[2] >= 1 && +m[2] <= 12) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  m = name.match(/(?:^|\D)(2\d)(\d{2})(\d{2})(?![0-9T])/); // 260421
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31)
    return new Date(2000 + +m[1], +m[2] - 1, +m[3]).getTime();
  if (/^\D*\d{4}\D*$/.test(name)) {
    m = name.match(/(\d{2})(\d{2})/); // 0421
    if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31)
      return new Date(new Date().getFullYear(), +m[1] - 1, +m[2]).getTime();
  }
  return null;
}

/**
 * ファイル名から回番号（第M回/第M講）を拾う。教授のファイル命名が一次情報 —
 * 休講がカレンダーに残っていると「N番目の開催=第N回」の数えがズレる
 * （データ処理プログラミングで実害: 5/20・6/10が休みなのに予定が残り全部1〜2回ズレた）。
 */
export function sessionNoFromFiles(files: string[]): number | null {
  for (const f of files) {
    // Kairos自身の書き出し（「YYYY-MM-DD …」要約md・「…（全文文字起こし）.txt」）は
    // 一次情報にしない。これを読むと自分が付けた回番号を根拠にしてしまい、教員資料と
    // 実際の回番号がズレても永遠に検出できなくなる（数学の世界で発覚した自己参照）。
    if (/^\d{4}-\d{2}-\d{2}[ 　]/.test(f) || f.includes("全文文字起こし")) continue;
    const m = f.match(/第\s*0*(\d{1,2})\s*[回講]/);
    if (m) return +m[1];
  }
  return null;
}

/** 指定授業・開催日のカレンダー回（第N回とeventKey）。フォルダ→予定の逆引き用。 */
export function occurrenceForDate(course: string, dateMs: number): Occurrence | null {
  const ymd = ymdOf(dateMs);
  return courseOccurrences(course).find((o) => o.ymd === ymd) ?? null;
}

export interface SessionView {
  n: number | null; // 第N回（カレンダーに無い日付フォルダは null）
  ymd: string;
  dateMs: number;
  eventKey: string | null;
  future: boolean;
  folder: string | null; // 授業フォルダ直下の回別フォルダ名
  files: string[];
  fileNo: number | null; // 資料ファイル名の「第M回」表記（一次情報）
  noMismatch: boolean; // 資料の回番号とカレンダー数えが食い違っている（要確認）
  noteId: string | null;
  noteStatus: string | null;
  noteTitle: string | null;
}

export interface CourseView {
  course: string;
  sessions: SessionView[];
  looseFiles: string[]; // 授業フォルダ直下の未整理ファイル
  otherFolders: { name: string; files: number }[]; // 日付でないフォルダ（課題プロジェクト等）
}

function ledgerNoteIds(): Record<string, string> {
  // folder-notes台帳: rel → noteId（相互import回避のためJSON直読み）
  try {
    const led = JSON.parse(
      fsSync.readFileSync(path.join(path.resolve(env.dataDir), "folder-notes.json"), "utf8"),
    ) as { folders?: Record<string, { noteId?: string | null }> };
    const out: Record<string, string> = {};
    for (const [rel, e] of Object.entries(led.folders ?? {})) if (e?.noteId) out[rel] = e.noteId;
    return out;
  } catch {
    return {};
  }
}

function exportDirNoteIds(): Map<string, string> {
  // notes-export台帳の逆引き: 書き出し先ディレクトリ → noteId
  try {
    const m = JSON.parse(
      fsSync.readFileSync(path.join(path.resolve(env.dataDir), "notes-export.json"), "utf8"),
    ) as Record<string, string[]>;
    const out = new Map<string, string>();
    for (const [noteId, paths] of Object.entries(m)) {
      for (const p of paths) out.set(path.dirname(p), noteId);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** 授業フォルダの回別ビュー: カレンダーの各回に、フォルダ・ファイル・ノートを対応付ける。 */
export async function courseView(course: string): Promise<CourseView> {
  const root = env.notesExportDir;
  const courseAbs = path.join(root, path.basename(course));
  const out: CourseView = { course, sessions: [], looseFiles: [], otherFolders: [] };
  if (!root) return out;

  const dirs: string[] = [];
  try {
    for (const e of await fs.readdir(courseAbs, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) out.looseFiles.push(e.name);
    }
  } catch {
    return out;
  }

  const listFiles = async (dirName: string) => {
    try {
      return (await fs.readdir(path.join(courseAbs, dirName), { withFileTypes: true }))
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };

  const ledger = ledgerNoteIds();
  const exportDirs = exportDirNoteIds();
  const noteRows = new Map(
    db.select().from(notes).where(isNull(notes.deletedAt)).all().map((r) => [r.id, r]),
  );
  const noteOf = (dirName: string): string | null =>
    ledger[path.join(path.basename(course), dirName)] ?? exportDirs.get(path.join(courseAbs, dirName)) ?? null;

  const today = ymdOf(Date.now());
  const usedDirs = new Set<string>();
  for (const o of courseOccurrences(course)) {
    const folder = dirs.find((d) => sessionDirMatches(d, o.ymd)) ?? null;
    if (folder) usedDirs.add(folder);
    const noteId = folder ? noteOf(folder) : null;
    const note = noteId ? noteRows.get(noteId) : null;
    const files = folder ? await listFiles(folder) : [];
    const fileNo = sessionNoFromFiles(files);
    out.sessions.push({
      n: o.n,
      ymd: o.ymd,
      dateMs: o.dateMs,
      eventKey: o.eventKey,
      future: o.ymd > today,
      folder,
      files,
      fileNo,
      noMismatch: fileNo != null && fileNo !== o.n,
      noteId: note ? noteId : null,
      noteStatus: note?.status ?? null,
      noteTitle: note?.title ?? null,
    });
  }

  // カレンダーと対応しない残りフォルダ: 日付らしければ回不明セッション、そうでなければその他
  for (const d of dirs) {
    if (usedDirs.has(d)) continue;
    const dateMs = dateFromFolderName(d);
    if (dateMs) {
      const noteId = noteOf(d);
      const note = noteId ? noteRows.get(noteId) : null;
      const files = await listFiles(d);
      out.sessions.push({
        n: null,
        ymd: ymdOf(dateMs),
        dateMs,
        eventKey: null,
        future: false,
        folder: d,
        files,
        fileNo: sessionNoFromFiles(files),
        noMismatch: false,
        noteId: note ? noteId : null,
        noteStatus: note?.status ?? null,
        noteTitle: note?.title ?? null,
      });
    } else {
      out.otherFolders.push({ name: d, files: (await listFiles(d)).length });
    }
  }
  out.sessions.sort((a, b) => a.dateMs - b.dateMs);
  return out;
}
