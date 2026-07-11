import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { events, notes } from "./db/schema";
import { env } from "./env";
import { runAgent } from "./agent";
import { pushNoteToOwui } from "./owui";

/**
 * NotebookLM-ish notes: audio in → whisperX transcript (local CPU) → agent
 * summary (markdown) → editable note, optionally attached to a calendar event.
 *
 * The pipeline runs detached from the request (transcription of a lecture
 * takes minutes); the UI polls the note's status. Restarting the server
 * abandons an in-flight note as "error" the next time it's read (staleMs).
 */

const AUDIO_SUBDIR = "audio";
const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".ogg", ".opus", ".flac", ".aac", ".webm", ".mp4"]);

export interface NoteView {
  id: string;
  eventKey: string | null;
  title: string;
  content: string | null;
  transcript: string | null;
  status: string;
  error: string | null;
  hasAudio: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

type NoteRow = typeof notes.$inferSelect;

function view(r: NoteRow): NoteView {
  return {
    id: r.id,
    eventKey: r.eventKey,
    title: r.title ?? "(無題)",
    content: r.content,
    transcript: r.transcript,
    status: r.status,
    error: r.error,
    hasAudio: !!r.audioPath,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function listNotes(eventKey?: string | null): NoteView[] {
  const rows = eventKey
    ? db.select().from(notes).where(eq(notes.eventKey, eventKey)).orderBy(desc(notes.createdAt)).all()
    : db.select().from(notes).where(isNull(notes.deletedAt)).orderBy(desc(notes.createdAt)).all();
  return rows.filter((r) => !r.deletedAt).map(view);
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
}

export function softDeleteNote(id: string) {
  db.update(notes).set({ deletedAt: Date.now() }).where(eq(notes.id, id)).run();
}

function setStatus(id: string, status: string, patch: Partial<typeof notes.$inferInsert> = {}) {
  db.update(notes).set({ status, updatedAt: Date.now(), ...patch }).where(eq(notes.id, id)).run();
}

/**
 * The Open WebUI notebook for a note: explicit user choice > the attached
 * event's title (recurring lectures share one, so notes pack per course) >
 * the catch-all. Keeps courses from mixing in RAG queries.
 */
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

function summarizePrompt(transcript: string, title: string, eventLabel: string | null): string {
  return [
    "以下は講義・会議などの音声を機械的に文字起こししたテキストです（誤認識を含みます）。",
    "内容を整理して、後から見返せる Markdown ノートを日本語で作ってください。",
    "構成: 冒頭に3行以内の要約。次に「## トピック」ごとの整理（見出し＋箇条書き）。",
    "課題・宿題・締切・約束事があれば必ず「## TODO・締切」節に抜き出す。",
    "登場した人名・固有名詞は「## 人物・用語」節に一行ずつ（分かる範囲の説明付き）。",
    "誤認識と思われる箇所は文脈から自然に補正してよい（創作はしない）。",
    "Markdown 本文だけを出力すること（前置き・コードフェンス不要）。",
    "",
    `# タイトル: ${title}`,
    eventLabel ? `# 関連する予定: ${eventLabel}` : "",
    "",
    "# 文字起こし",
    transcript.slice(0, 60_000), // keep the prompt bounded
  ].filter(Boolean).join("\n");
}

/** Fire-and-forget pipeline body. All failures land in the note row. */
async function pipeline(noteId: string, audioAbs: string, title: string, eventLabel: string | null, notebook: string | null, language = "ja") {
  const outDir = path.join(path.dirname(audioAbs), `wx-${noteId}`);
  try {
    const wx = await runWhisperx(audioAbs, outDir, language);
    if (!wx.ok) {
      setStatus(noteId, "error", { error: `文字起こし失敗: ${wx.err}` });
      return;
    }
    const base = path.basename(audioAbs).replace(/\.[^.]+$/, "");
    const transcript = (await fs.readFile(path.join(outDir, `${base}.txt`), "utf8")).trim();
    if (!transcript) {
      setStatus(noteId, "error", { error: "文字起こし結果が空でした" });
      return;
    }
    setStatus(noteId, "summarizing", { transcript: transcript.slice(0, 200_000) });

    const res = await runAgent(summarizePrompt(transcript, title, eventLabel), {
      agent: "claude",
      jobKind: "note-summary",
      timeoutMs: 600_000,
    });
    if (!res.ok) {
      // keep the transcript — the note is still useful without the summary
      setStatus(noteId, "error", { error: `要約失敗: ${res.error}`, jobId: res.jobId });
      return;
    }
    const content = res.text.trim().slice(0, 200_000);
    setStatus(noteId, "done", { content, jobId: res.jobId, notebook });
    // NotebookLM layer: make the note queryable from the Open WebUI chat
    void pushNoteToOwui({ id: noteId, title, content, transcript }, notebook).then((fid) => {
      if (fid) db.update(notes).set({ owuiFileId: fid }).where(eq(notes.id, noteId)).run();
    });
  } catch (e) {
    setStatus(noteId, "error", { error: String(e).slice(0, 500) });
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Save the uploaded audio and start the pipeline. Returns the new note id. */
export async function ingestAudioNote(opts: {
  buf: Buffer;
  filename: string;
  title: string;
  eventKey?: string | null;
  eventLabel?: string | null; // e.g. "狩野研先端 7/2 14:25" — context for the summary
  notebook?: string | null; // Open WebUI collection override (packing)
  language?: string | null; // "ja"(既定) | "en" 等 | "auto"=自動判定
}): Promise<string> {
  const ext = (path.extname(opts.filename) || "").toLowerCase();
  if (!AUDIO_EXT.has(ext)) throw new Error(`未対応の形式です: ${ext || "(拡張子なし)"}`);
  const dir = path.join(path.resolve(env.dataDir), AUDIO_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const audioAbs = path.join(dir, `${id}${ext}`);
  await fs.writeFile(audioAbs, opts.buf);

  const now = Date.now();
  db.insert(notes)
    .values({
      id,
      eventKey: opts.eventKey ?? null,
      title: opts.title || opts.filename,
      status: "transcribing",
      audioPath: audioAbs,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // detached — the UI polls /api/notes for status
  void pipeline(
    id,
    audioAbs,
    opts.title || opts.filename,
    opts.eventLabel ?? null,
    notebookFor(opts.notebook, opts.eventKey),
    opts.language?.trim() || "ja",
  );
  return id;
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

/** 音声が残っているノートを再文字起こし（言語・アンチループ設定を変えてやり直す）。 */
export function redoTranscription(id: string, language = "ja"): boolean {
  const r = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!r || r.deletedAt || !r.audioPath) return false;
  setStatus(id, "transcribing", { error: null });
  void pipeline(id, r.audioPath, r.title ?? "(無題)", null, r.notebook, language);
  return true;
}
