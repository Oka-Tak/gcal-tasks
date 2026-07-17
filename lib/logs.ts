import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "./db";
import { logs } from "./db/schema";
import { env } from "./env";
import { runAgent, extractJson } from "./agent";
import { runVisionAuto } from "./vision";
import { serializeLog } from "./serialize";

const UPLOAD_SUBDIR = "uploads";

function uploadsDir(): string {
  return path.resolve(env.dataDir, UPLOAD_SUBDIR);
}

/** Persist an uploaded image locally (never web-served). Returns the absolute path. */
export async function saveUploadImage(buf: Buffer, filename: string): Promise<string> {
  const dir = uploadsDir();
  await fs.mkdir(dir, { recursive: true });
  const ext = (path.extname(filename) || ".png").toLowerCase().replace(/[^.a-z0-9]/g, "");
  const abs = path.join(dir, `${crypto.randomUUID()}${ext}`);
  await fs.writeFile(abs, buf);
  return abs;
}

/** A normalized, not-yet-saved log the user reviews before confirming. */
export interface LogDraft {
  kind: string;
  title: string | null;
  note: string | null;
  start: string | null; // ISO local datetime
  end: string | null;
  startMs: number | null;
  endMs: number | null;
  tags: string[];
  metrics: Record<string, unknown>;
  source: string;
  imagePath?: string;
}

interface RawExtract {
  date?: string;
  start?: string;
  end?: string;
  title?: string;
  note?: string;
  tags?: string[];
  metrics?: Record<string, unknown>;
}

function toMs(s: string | undefined | null): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

function buildSleepPrompt(source: string, nowISO: string): string {
  return [
    `今日は ${nowISO} です（参照用）。`,
    source,
    `読み取れる内容から、次の JSON オブジェクトだけを出力してください（前後に文章・コードフェンスを付けない）。`,
    `{`,
    `  "date": "YYYY-MM-DD（起床した日。読めなければ今日）",`,
    `  "start": "就寝時刻の ISO8601 ローカル日時 例 2026-06-16T23:30:00（読めなければ null）",`,
    `  "end": "起床時刻の ISO8601 ローカル日時（読めなければ null）",`,
    `  "title": "短い見出し 例 睡眠 7h12m",`,
    `  "note": "気づいた点（任意・無ければ空文字）",`,
    `  "tags": ["任意のタグ"],`,
    `  "metrics": { "durationMin": 数値, "score": 数値, "deepMin": 数値, "remMin": 数値, "lightMin": 数値, "awakeMin": 数値 }`,
    `}`,
    `読み取れない数値フィールドは省略するか null にしてください。推測で値を作らないこと。`,
  ].join("\n");
}

/** Vision-extract a sleep screenshot into a draft (does NOT save). */
export async function extractSleepFromImage(imageAbs: string): Promise<{
  draft: LogDraft | null;
  jobId: string;
  ok: boolean;
  error?: string;
  raw: string;
}> {
  const nowISO = new Date().toISOString();
  // claude limit時はローカルOCR+別LLMへ自動フォールバック（docs/AGENT-FALLBACK.md）
  const res = await runVisionAuto({
    visionPrompt: buildSleepPrompt(
      `画像ファイル ${imageAbs} を Read ツールで開いてください。これはスマートウォッチ（Xiaomi）の睡眠記録のスクリーンショットです。`,
      nowISO,
    ),
    ocrPrompt: (ocrText) =>
      buildSleepPrompt(
        `以下はスマートウォッチ（Xiaomi）の睡眠記録スクリーンショットをOCRしたテキストです（誤認識を含みます）。\n# OCRテキスト\n${ocrText}`,
        nowISO,
      ),
    imageAbs,
    jobKind: "extract-sleep",
  });
  if (!res.ok) {
    return { draft: null, jobId: res.jobId, ok: false, error: res.error, raw: res.text };
  }
  const parsed = extractJson<RawExtract>(res.text);
  if (!parsed) {
    return {
      draft: null,
      jobId: res.jobId,
      ok: false,
      error: "抽出結果を JSON として解釈できませんでした",
      raw: res.text,
    };
  }
  const start = parsed.start ?? null;
  const end = parsed.end ?? null;
  const draft: LogDraft = {
    kind: "sleep",
    title: parsed.title ?? null,
    note: parsed.note || null,
    start,
    end,
    startMs: toMs(start),
    endMs: toMs(end),
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    metrics: parsed.metrics ?? {},
    source: "screenshot",
    imagePath: imageAbs,
  };
  return { draft, jobId: res.jobId, ok: true, raw: res.text };
}

/** Confirm-save a log row. */
export function saveLog(d: LogDraft) {
  const now = Date.now();
  const row = {
    id: crypto.randomUUID(),
    kind: d.kind,
    title: d.title ?? null,
    note: d.note ?? null,
    startMs: d.startMs ?? null,
    endMs: d.endMs ?? null,
    tags: JSON.stringify(d.tags ?? []),
    metrics: JSON.stringify(d.metrics ?? {}),
    source: d.source ?? "manual",
    imagePath: d.imagePath ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null as number | null,
  };
  db.insert(logs).values(row).run();
  return serializeLog(row);
}

export function listLogs(limit = 100) {
  return db
    .select()
    .from(logs)
    .where(isNull(logs.deletedAt))
    .orderBy(desc(logs.startMs), desc(logs.createdAt))
    .limit(limit)
    .all()
    .map(serializeLog);
}

/** Logs overlapping [minMs, maxMs) — the calendar's "actuals" overlay. */
export function listLogsRange(minMs: number, maxMs: number) {
  return db
    .select()
    .from(logs)
    .where(and(isNull(logs.deletedAt), gt(logs.endMs, minMs), lt(logs.startMs, maxMs)))
    .orderBy(asc(logs.startMs))
    .all()
    .map(serializeLog);
}

export function softDeleteLog(id: string) {
  db.update(logs).set({ deletedAt: Date.now() }).where(eq(logs.id, id)).run();
}
