import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { events, noteAudios, notes } from "./db/schema";
import { env } from "./env";
import { runAgent, runAgentAuto } from "./agent";
import { pushNoteToOwui } from "./owui";
import { dateFromTitle, exportNoteFiles, inferCourseNotebook, removeExportedFiles, resolveNoteDir } from "./notes-export";

/**
 * フォルダ⇔ノートの1対1対応: ノート作成時点で置き先フォルダを解決して
 * folder-notes 台帳に紐付ける。以後そのフォルダへの資料・音声の追加が
 * このノートを更新し、要約にはフォルダの配布資料テキストが入る。
 * フォルダに既に別ノートが居る場合は紐付けない（1対1を壊さない）。
 */
async function bindToResolvedFolder(noteId: string, notebook: string | null, eventKey: string | null, title: string | null): Promise<void> {
  try {
    const nb = notebook ?? (await inferCourseNotebook(title).catch(() => null));
    const dir = await resolveNoteDir(nb, eventStartMs(eventKey) ?? dateFromTitle(title, Date.now()));
    if (!dir) return;
    const { bindNoteToFolder } = await import("./folder-notes"); // 相互import回避
    await bindNoteToFolder(noteId, dir);
  } catch (e) {
    console.log(`[notes] folder bind failed (${noteId}): ${String(e).slice(0, 120)}`);
  }
}

/**
 * NotebookLM-ish notes: audio in → whisperX transcript (local CPU) → agent
 * summary (markdown) → editable note, optionally attached to a calendar event.
 *
 * The pipeline runs detached from the request (transcription of a lecture
 * takes minutes); the UI polls the note's status. Restarting the server
 * abandons an in-flight note as "error" the next time it's read (staleMs).
 */

const AUDIO_SUBDIR = "audio";
export const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".ogg", ".opus", ".flac", ".aac", ".webm", ".mp4"]);

export interface NoteAudioView {
  id: string;
  seq: number;
  label: string | null;
  language: string | null;
  status: string; // pending | transcribing | done | error
  error: string | null;
}

export interface NoteView {
  id: string;
  eventKey: string | null;
  title: string;
  content: string | null;
  transcript: string | null;
  status: string;
  error: string | null;
  hasAudio: boolean;
  audios: NoteAudioView[];
  notebook: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

type NoteRow = typeof notes.$inferSelect;
type AudioRow = typeof noteAudios.$inferSelect;

function audioRows(noteId: string): AudioRow[] {
  return db.select().from(noteAudios).where(eq(noteAudios.noteId, noteId)).orderBy(asc(noteAudios.seq)).all();
}

function view(r: NoteRow, audios?: AudioRow[]): NoteView {
  const a = audios ?? audioRows(r.id);
  return {
    id: r.id,
    eventKey: r.eventKey,
    title: r.title ?? "(無題)",
    content: r.content,
    transcript: r.transcript,
    status: r.status,
    error: r.error,
    hasAudio: !!r.audioPath || a.length > 0,
    audios: a.map((x) => ({ id: x.id, seq: x.seq, label: x.label, language: x.language, status: x.status, error: x.error })),
    notebook: r.notebook ?? notebookFor(null, r.eventKey),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function listNotes(eventKey?: string | null): NoteView[] {
  const rows = eventKey
    ? db.select().from(notes).where(eq(notes.eventKey, eventKey)).orderBy(desc(notes.createdAt)).all()
    : db.select().from(notes).where(isNull(notes.deletedAt)).orderBy(desc(notes.createdAt)).all();
  return rows.filter((r) => !r.deletedAt).map((r) => view(r));
}

export function getNote(id: string): NoteView | null {
  const r = db.select().from(notes).where(eq(notes.id, id)).get();
  return r && !r.deletedAt ? view(r) : null;
}

/**
 * Edit title/content — and re-push the OWUI copy so RAG doesn't keep serving
 * the pre-edit text (the old file is replaced via owuiFileId).
 */
export function updateNote(id: string, patch: { title?: string; content?: string }) {
  db.update(notes)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(notes.id, id))
    .run();
  const r = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!r || r.deletedAt || r.status !== "done") return;
  void pushNoteToOwui(
    { id: r.id, title: r.title, content: r.content, transcript: r.transcript },
    r.notebook ?? notebookFor(null, r.eventKey),
    r.owuiFileId,
  ).then((fid) => {
    if (fid) db.update(notes).set({ owuiFileId: fid }).where(eq(notes.id, id)).run();
  });
  void exportNoteFiles(
    { ...r, notebook: r.notebook ?? notebookFor(null, r.eventKey) },
    eventStartMs(r.eventKey),
  ).catch((e) => console.log(`[notes-export] failed: ${e}`));
}

export function softDeleteNote(id: string) {
  db.update(notes).set({ deletedAt: Date.now() }).where(eq(notes.id, id)).run();
  void removeExportedFiles(id).catch(() => {});
}

function setStatus(id: string, status: string, patch: Partial<typeof notes.$inferInsert> = {}) {
  db.update(notes).set({ status, updatedAt: Date.now(), ...patch }).where(eq(notes.id, id)).run();
}

/**
 * The Open WebUI notebook for a note: explicit user choice > the attached
 * event's title (recurring lectures share one, so notes pack per course) >
 * the catch-all. Keeps courses from mixing in RAG queries.
 */
/** 紐付いた予定の開始時刻（講義日）。回別フォルダ（20260702等）の解決に使う。 */
export function eventStartMs(eventKey: string | null | undefined): number | null {
  if (!eventKey) return null;
  const [account, calendarId, googleId] = eventKey.split("|");
  const ev = db
    .select({ startMs: events.startMs })
    .from(events)
    .where(and(eq(events.account, account), eq(events.calendarId, calendarId), eq(events.googleId, googleId)))
    .get();
  return ev?.startMs ?? null;
}

export function notebookFor(explicit: string | null | undefined, eventKey: string | null | undefined): string | null {
  if (explicit?.trim()) return explicit.trim();
  if (eventKey) {
    const [account, calendarId, googleId] = eventKey.split("|");
    const ev = db
      .select({ summary: events.summary })
      .from(events)
      .where(and(eq(events.account, account), eq(events.calendarId, calendarId), eq(events.googleId, googleId)))
      .get();
    if (ev?.summary) return `講義: ${ev.summary}`;
  }
  return null; // → owui.ts falls back to the default collection
}

/* ------------------------------------------------------------ transcription */

function runWhisperx(audioAbs: string, outDir: string, language = "ja"): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const args = [
      audioAbs,
      "--model", env.whisperxModel,
      // "auto" は --language を渡さない = Whisperの自動判定(冒頭30秒で検出)
      ...(language && language !== "auto" ? ["--language", language] : []),
      "--device", "cpu",
      "--compute_type", "int8",
      "--no_align",
      // 幻覚ループ対策: 前セグメントの文脈引き継ぎを切る(雑音・無音で
      // 「私たちの話をしていますが…」型の無限繰り返しになる既知の問題)
      "--condition_on_previous_text", "False",
      "--output_dir", outDir,
      "--output_format", "txt",
    ];
    let child;
    try {
      child = spawn(env.whisperxBin, args, { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ ok: false, err: String(e) });
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, err: `timed out after ${env.transcribeTimeoutMs}ms` });
    }, env.transcribeTimeoutMs);
    child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, err: String(e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, err: code === 0 ? "" : stderr.slice(-2000) });
    });
  });
}

function summarizePrompt(
  transcript: string,
  title: string,
  eventLabel: string | null,
  materialsText?: string | null,
): string {
  const hasT = !!transcript.trim();
  const hasM = !!materialsText?.trim();
  return [
    hasT
      ? "以下は講義・会議などの音声を機械的に文字起こししたテキストです（誤認識を含みます）。"
      : "以下は講義・活動の配布資料から機械的に抽出したテキストです（レイアウト崩れを含みます）。",
    hasT
      ? "「===== 音源N: … =====」の見出しがある場合は複数の録音を順に並べた1セットです（例: 前半/後半、講義+上映動画）。全体をひとつの内容として扱ってください。"
      : "",
    hasT && hasM
      ? "「# 配布資料」以下は同じ回の配布資料（スライド等）の抽出テキストです。文字起こしの用語補正と内容の補完に使ってください。"
      : "",
    "内容を整理して、後から見返せる Markdown ノートを日本語で作ってください。",
    "構成: 冒頭に3行以内の要約。次に「## トピック」ごとの整理（見出し＋箇条書き）。",
    "課題・宿題・締切・約束事があれば必ず「## TODO・締切」節に抜き出す。",
    "登場した人名・固有名詞は「## 人物・用語」節に一行ずつ（分かる範囲の説明付き）。",
    hasT ? "誤認識と思われる箇所は文脈から自然に補正してよい（創作はしない）。" : "資料に無い内容を創作しないこと。",
    "ツールは一切使わないこと。ファイルへの保存も試みないこと（保存はこちらで行う）。",
    "Markdown 本文だけを出力すること（前置き・断り書き・コードフェンス不要）。",
    "",
    `# タイトル: ${title}`,
    eventLabel ? `# 関連する予定: ${eventLabel}` : "",
    ...(hasM ? ["", "# 配布資料", materialsText!.slice(0, 60_000)] : []),
    ...(hasT ? ["", "# 文字起こし", transcript.slice(0, 60_000)] : []), // keep the prompt bounded
  ].filter(Boolean).join("\n");
}

/** 旧ノート(notes.audio_path 単発)を note_audios 一行に読み替える。 */
function ensureAudioRows(r: NoteRow): AudioRow[] {
  let rows = audioRows(r.id);
  if (rows.length === 0 && r.audioPath) {
    db.insert(noteAudios)
      .values({
        id: crypto.randomUUID(),
        noteId: r.id,
        seq: 1,
        label: path.basename(r.audioPath),
        audioPath: r.audioPath,
        language: "ja",
        transcript: r.transcript,
        status: r.transcript ? "done" : "pending",
        createdAt: r.createdAt ?? Date.now(),
      })
      .run();
    rows = audioRows(r.id);
  }
  return rows;
}

async function transcribeOne(a: AudioRow): Promise<void> {
  const outDir = path.join(path.dirname(a.audioPath), `wx-${a.id}`);
  db.update(noteAudios).set({ status: "transcribing", error: null }).where(eq(noteAudios.id, a.id)).run();
  try {
    const wx = await runWhisperx(a.audioPath, outDir, a.language ?? "ja");
    if (!wx.ok) {
      db.update(noteAudios).set({ status: "error", error: wx.err.slice(0, 500) }).where(eq(noteAudios.id, a.id)).run();
      return;
    }
    const base = path.basename(a.audioPath).replace(/\.[^.]+$/, "");
    const transcript = (await fs.readFile(path.join(outDir, `${base}.txt`), "utf8")).trim();
    db.update(noteAudios)
      .set(transcript ? { status: "done", transcript: transcript.slice(0, 200_000) } : { status: "error", error: "文字起こし結果が空でした" })
      .where(eq(noteAudios.id, a.id))
      .run();
  } catch (e) {
    db.update(noteAudios).set({ status: "error", error: String(e).slice(0, 500) }).where(eq(noteAudios.id, a.id)).run();
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 全音源の文字起こしを結合（1本ならそのまま、複数なら見出し区切り）。 */
function combineTranscripts(rows: AudioRow[]): string {
  const done = rows.filter((r) => r.status === "done" && r.transcript);
  if (done.length === 1 && rows.length === 1) return done[0].transcript!;
  return rows
    .map((r) => {
      const head = `===== 音源${r.seq}: ${r.label ?? "(無題)"}${r.language && r.language !== "ja" ? ` [${r.language}]` : ""} =====`;
      const body = r.status === "done" ? (r.transcript ?? "") : `(文字起こし失敗: ${r.error ?? r.status})`;
      return `${head}\n\n${body}`;
    })
    .join("\n\n");
}

// 同じノートの pipeline 二重起動を防ぐ。実行中に再要求が来たら（要約中の
// 音源追加など、ループが拾えないタイミング）終了後にもう一周する。
const inFlight = new Set<string>();
const rerun = new Set<string>();

/**
 * Fire-and-forget pipeline: pending な音源を seq 順に whisperx へ流し、
 * 全部さばけたら結合して要約する。失敗はノート行と音源行に残る。
 */
async function pipeline(noteId: string, title: string, eventLabel: string | null, notebook: string | null) {
  if (inFlight.has(noteId)) {
    rerun.add(noteId);
    return;
  }
  inFlight.add(noteId);
  try {
    for (;;) {
      const next = audioRows(noteId).find((a) => a.status === "pending" || a.status === "transcribing");
      if (!next) break;
      await transcribeOne(next);
    }
    const rows = audioRows(noteId);
    if (rows.length === 0 || !rows.some((r) => r.status === "done" && r.transcript)) {
      const err = rows.map((r) => r.error).filter(Boolean)[0] ?? "文字起こし結果が空でした";
      setStatus(noteId, "error", { error: `文字起こし失敗: ${err}` });
      return;
    }
    const transcript = combineTranscripts(rows).slice(0, 200_000);
    await summarizeAndPublish(noteId, title, eventLabel, notebook, transcript);
  } catch (e) {
    setStatus(noteId, "error", { error: String(e).slice(0, 500) });
  } finally {
    inFlight.delete(noteId);
    if (rerun.delete(noteId)) void pipeline(noteId, title, eventLabel, notebook);
  }
}

/**
 * 要約→公開の後段（音声パイプラインとフォルダノート共用）: 文字起こし（無くても
 * 可）と、フォルダ紐付きノートなら同じフォルダの配布資料テキストを合わせて
 * Markdownノートを生成し、done化 → OWUI登録 → フォルダ書き出しまで行う。
 */
export async function summarizeAndPublish(
  noteId: string,
  title: string,
  eventLabel: string | null,
  notebook: string | null,
  transcript: string,
): Promise<void> {
  setStatus(noteId, "summarizing", transcript ? { transcript } : {});
  const materialsText = await import("./folder-notes")
    .then((m) => m.folderMaterialsText(noteId))
    .catch(() => null);
  if (!transcript.trim() && !materialsText?.trim()) {
    setStatus(noteId, "error", { error: "要約する素材がありません（文字起こしも資料テキストも空）" });
    return;
  }
  // claudeの5h枠が薄い時は codex → copilot → agy に自動で逃がす（要約はどれでも可）
  const res = await runAgentAuto(summarizePrompt(transcript, title, eventLabel, materialsText), {
    jobKind: "note-summary",
    timeoutMs: 600_000,
  });
  if (!res.ok) {
    // keep the transcript — the note is still useful without the summary
    setStatus(noteId, "error", { error: `要約失敗: ${res.error}`, jobId: res.jobId });
    return;
  }
  const content = res.text.trim().slice(0, 200_000);
  // 分類も予定も無いノートはタイトルから授業を推定（「地震防災0711」→講義: 地震防災）。
  // これが決まると OWUI の棚もフォルダ書き出し先も授業に揃う。
  const nb = notebook ?? (await inferCourseNotebook(title).catch(() => null));
  setStatus(noteId, "done", { content, jobId: res.jobId, notebook: nb });
  // NotebookLM layer: make the note queryable from the Open WebUI chat
  void pushNoteToOwui({ id: noteId, title, content, transcript: transcript || null }, nb).then((fid) => {
    if (fid) db.update(notes).set({ owuiFileId: fid }).where(eq(notes.id, noteId)).run();
  });
  // フォルダ集約: 要約md+全文txt を OneDrive の授業資料フォルダ（回別があればそこ）へ
  const done = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (done)
    void exportNoteFiles(done, eventStartMs(done.eventKey)).catch((e) =>
      console.log(`[notes-export] failed: ${e}`),
    );
}

/** フォルダ監視が文字起こし中のCPU競合を避けるための実行中パイプライン数。 */
export function inFlightCount(): number {
  return inFlight.size;
}

export interface AudioSource {
  buf: Buffer;
  filename: string;
  language?: string | null; // "ja"(既定) | "en" 等 | "auto"=自動判定
}

/** 音源ファイルを保存して note_audios 行を積む。 */
async function saveAudioSource(noteId: string, seq: number, src: AudioSource): Promise<void> {
  const ext = (path.extname(src.filename) || "").toLowerCase();
  if (!AUDIO_EXT.has(ext)) throw new Error(`未対応の形式です: ${ext || "(拡張子なし)"} (${src.filename})`);
  const dir = path.join(path.resolve(env.dataDir), AUDIO_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  const audioId = crypto.randomUUID();
  const audioAbs = path.join(dir, `${audioId}${ext}`);
  await fs.writeFile(audioAbs, src.buf);
  db.insert(noteAudios)
    .values({
      id: audioId,
      noteId,
      seq,
      label: src.filename,
      audioPath: audioAbs,
      language: src.language?.trim() || "ja",
      status: "pending",
      createdAt: Date.now(),
    })
    .run();
}

/** Save the uploaded audio(s) and start the pipeline. Returns the new note id. */
export async function ingestAudioNote(opts: {
  files: AudioSource[]; // 1セット＝複数音源可（前半/後半、日本語+英語上映など）
  title: string;
  eventKey?: string | null;
  eventLabel?: string | null; // e.g. "狩野研先端 7/2 14:25" — context for the summary
  notebook?: string | null; // Open WebUI collection override (packing)
}): Promise<string> {
  if (opts.files.length === 0) throw new Error("音声ファイルがありません");
  const id = crypto.randomUUID();
  const now = Date.now();
  db.insert(notes)
    .values({
      id,
      eventKey: opts.eventKey ?? null,
      title: opts.title || opts.files[0].filename,
      status: "transcribing",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  try {
    for (let i = 0; i < opts.files.length; i++) await saveAudioSource(id, i + 1, opts.files[i]);
  } catch (e) {
    setStatus(id, "error", { error: String(e).slice(0, 500) });
    throw e;
  }

  // フォルダ⇔ノート1対1: 先に紐付けてから流す（要約がフォルダの資料テキストを拾える）
  const nb = notebookFor(opts.notebook, opts.eventKey);
  await bindToResolvedFolder(id, nb, opts.eventKey ?? null, opts.title || opts.files[0].filename);
  // detached — the UI polls /api/notes for status
  void pipeline(id, opts.title || opts.files[0].filename, opts.eventLabel ?? null, nb);
  return id;
}

/** 既存ノートに音源を追加し、文字起こし→再結合→再要約する。 */
export async function addAudiosToNote(noteId: string, files: AudioSource[]): Promise<boolean> {
  const r = db.select().from(notes).where(eq(notes.id, noteId)).get();
  if (!r || r.deletedAt || files.length === 0) return false;
  const existing = ensureAudioRows(r);
  let seq = existing.reduce((m, a) => Math.max(m, a.seq), 0);
  for (const f of files) await saveAudioSource(noteId, ++seq, f);
  setStatus(noteId, "transcribing", { error: null });
  void pipeline(noteId, r.title ?? "(無題)", null, r.notebook ?? notebookFor(null, r.eventKey));
  return true;
}

/** Create an empty manual note (no audio). */
export function createManualNote(opts: { title: string; content?: string; eventKey?: string | null; notebook?: string | null }): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.insert(notes)
    .values({
      id,
      eventKey: opts.eventKey ?? null,
      title: opts.title,
      content: opts.content ?? "",
      status: "done",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const nb = notebookFor(opts.notebook, opts.eventKey);
  if (nb) db.update(notes).set({ notebook: nb }).where(eq(notes.id, id)).run();
  void bindToResolvedFolder(id, nb, opts.eventKey ?? null, opts.title);
  if (opts.content) {
    void pushNoteToOwui(
      { id, title: opts.title, content: opts.content, transcript: null },
      nb,
    ).then((fid) => {
      if (fid) db.update(notes).set({ owuiFileId: fid }).where(eq(notes.id, id)).run();
    });
  }
  return id;
}

/**
 * 音声が残っているノートを再文字起こし（言語・アンチループ設定を変えてやり直す）。
 * audioId 指定でその音源だけ、省略で全音源をやり直し、結合・要約し直す。
 */
export function redoTranscription(id: string, language = "ja", audioId?: string | null): boolean {
  const r = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!r || r.deletedAt) return false;
  const rows = ensureAudioRows(r);
  const targets = audioId ? rows.filter((a) => a.id === audioId) : rows;
  if (targets.length === 0) return false;
  for (const a of targets) {
    db.update(noteAudios).set({ status: "pending", language, error: null }).where(eq(noteAudios.id, a.id)).run();
  }
  setStatus(id, "transcribing", { error: null });
  void pipeline(id, r.title ?? "(無題)", null, r.notebook ?? notebookFor(null, r.eventKey));
  return true;
}
