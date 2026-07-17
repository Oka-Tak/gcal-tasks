import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "./db";
import { env } from "./env";
import { tasklists, tasks } from "./db/schema";
import { runAgentAuto, extractJson } from "./agent";
import { createTasksBulk, type TaskWrite } from "./mutations";

/**
 * 学務情報システム(gakujo/lcu-web)の課題一覧を Kairos タスク化する。
 * MFA があるためログインはブラウザ側で済ませ、ブックマークレットが課題一覧
 * ページのテキストを投げてくる。レイアウト変更に強いよう抽出はAIに任せ、
 * 締切つきGoogleタスク(=カレンダーにも表示)を作る。[gakujo:key] で冪等。
 */

interface Assignment {
  course?: string;
  title?: string;
  due?: string; // YYYY-MM-DD
  dueTime?: string; // HH:MM
  submitted?: boolean;
  kind?: string; // レポート | 小テスト | アンケート
}

function extractPrompt(text: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "以下は静岡大学の学務情報システムの『課題一覧』ページから抜き出したテキストです。",
    "レポート・小テスト・アンケート等の課題を読み取り、JSON配列だけを出力してください。",
    "各要素:",
    '{"course":"科目名","title":"課題名","kind":"レポート|小テスト|アンケート","due":"YYYY-MM-DD","dueTime":"HH:MM(不明ならnull)","submitted":提出済みならtrue}',
    "ルール:",
    "- 締切日時が読み取れないものは due を null にする（推測しない）。",
    "- 和暦や『2026/07/10 23:59』『7月10日』等はYYYY-MM-DDに正規化。時刻はHH:MM。",
    "- 提出済み・受付終了が明らかなものは submitted:true。判別不能は false。",
    "- 課題が1件も無ければ [] を出力。",
    "JSON配列のみ。前置き・コードフェンス不要。",
    "",
    `# 今日: ${today}`,
    "# 課題一覧テキスト",
    text.slice(0, 40_000),
  ].join("\n");
}

function keyOf(a: Assignment): string {
  return crypto.createHash("sha1").update(`${a.course ?? ""}|${a.title ?? ""}|${a.due ?? ""}`).digest("hex").slice(0, 12);
}

/** 取り込み先: 明示指定 > 最初の「マイタスク」> 最初のリスト。 */
function targetList(): { account: string; tasklist: string } | null {
  const rows = db.select().from(tasklists).where(isNull(tasklists.deletedAt)).all();
  if (!rows.length) return null;
  const mine = rows.find((r) => r.title === "マイタスク") ?? rows[0];
  return { account: mine.account, tasklist: mine.googleId };
}

export interface ImportResult {
  ok: boolean;
  created: number;
  skipped: number;
  pastOrDone: number;
  noDue: number;
  items: { title: string; due: string | null; status: "created" | "skipped" | "no-due" | "past-or-done" }[];
  error?: string;
}

/** 構造化済みの課題リスト（ユーザースクリプトの決定論パース）から直接タスク化。 */
export async function importGakujoStructured(list: Assignment[]): Promise<ImportResult> {
  return createFromList(Array.isArray(list) ? list : []);
}

/** 課題一覧ページのテキストから AI 抽出してタスク化（ブックマークレットの汎用経路）。 */
export async function importGakujoAssignments(text: string): Promise<ImportResult> {
  const empty: ImportResult = { ok: true, created: 0, skipped: 0, pastOrDone: 0, noDue: 0, items: [] };
  if (!text || text.length < 20) return { ...empty, ok: false, error: "本文が空です" };

  const res = await runAgentAuto(extractPrompt(text), { model: "haiku", jobKind: "gakujo-import", timeoutMs: 120_000 });
  if (!res.ok) return { ...empty, ok: false, error: `抽出失敗: ${res.error}` };
  const list = extractJson<Assignment[]>(res.text);
  if (!Array.isArray(list)) return { ...empty, ok: false, error: "抽出結果をJSONとして解釈できませんでした" };
  return createFromList(list);
}

async function createFromList(list: Assignment[]): Promise<ImportResult> {
  const empty: ImportResult = { ok: true, created: 0, skipped: 0, pastOrDone: 0, noDue: 0, items: [] };
  const target = targetList();
  if (!target) return { ...empty, ok: false, error: "書き込み先タスクリストがありません（Googleアカウント連携を確認）" };

  const today = new Date().toISOString().slice(0, 10);
  const out: ImportResult = { ...empty, items: [] };
  const toCreate: TaskWrite[] = []; // 実際に作る分を貯めて最後に一括
  for (const a of list.slice(0, 60)) {
    const title = `【課題】${a.course ? `${a.course}: ` : ""}${a.title ?? "(無題)"}`;
    if (a.submitted) { out.pastOrDone++; out.items.push({ title, due: a.due ?? null, status: "past-or-done" }); continue; }
    if (!a.due || !/^\d{4}-\d{2}-\d{2}$/.test(a.due)) { out.noDue++; out.items.push({ title, due: null, status: "no-due" }); continue; }
    if (a.due < today) { out.pastOrDone++; out.items.push({ title, due: a.due, status: "past-or-done" }); continue; }

    const key = keyOf(a);
    // 重複判定: gakujoマーカー一致 or 同一正規化タイトルの未完了タスクが既にある。
    // 詳細取り込み(📚)やAI推定で先にタスクができている課題を二重作成しない。
    const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    const titleN = norm(title);
    const dup = db.select({ id: tasks.googleId, notes: tasks.notes, title: tasks.title })
      .from(tasks)
      .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
      .all()
      .find((t) => (t.notes ?? "").includes(`[gakujo:${key}]`) || norm(t.title) === titleN);
    if (dup) {
      // マーカーが無い既存タスク（手動・詳細取り込み由来）には付けておく＝次回も安定
      if (!(dup.notes ?? "").includes(`[gakujo:${key}]`)) {
        db.update(tasks).set({ notes: `${dup.notes ?? ""}\n[gakujo:${key}]`.trim() }).where(eq(tasks.googleId, dup.id)).run();
      }
      out.skipped++; out.items.push({ title, due: a.due, status: "skipped" }); continue;
    }

    toCreate.push({
      account: target.account,
      tasklist: target.tasklist,
      title,
      notes: `学務情報システムの課題（自動取り込み）\n[gakujo:${key}]`,
      due: a.due,
      ...(a.dueTime && /^\d{2}:\d{2}$/.test(a.dueTime) ? { dueTime: a.dueTime } : {}),
    });
    out.items.push({ title, due: a.due, status: "created" });
  }
  // 全件を1回の同期で作る（1件ごとのフル同期でtimeoutしていた）
  if (toCreate.length) {
    try {
      out.created = await createTasksBulk(toCreate);
    } catch (e) {
      return { ...out, ok: false, error: `タスク作成失敗: ${String(e).slice(0, 160)}` };
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 課題詳細 */

export interface GakujoDetail {
  course: string; // 例: AIシステムⅠ（ローマ数字揺れはNFKCで吸収）
  title: string;
  body: string; // 設問・課題説明の本文
  due?: string | null; // YYYY-MM-DD
  dueTime?: string | null; // HH:MM
  grading?: string | null; // 評価方法
  url?: string | null;
}

/**
 * 課題詳細ページ（設問文）の取り込み: 授業フォルダに md として保存し
 * （owui-sync が RAG「講義: X」へ登録 → チャット/タスクAI推定が設問を読める）、
 * 対応するタスクがあれば notes に要点を書き込む（Google Tasks経由でスマホでも見える）。
 * 同じ課題を再送すると md を上書き（冪等）。
 */
export async function importGakujoDetail(d: GakujoDetail): Promise<{
  ok: boolean;
  savedTo?: string;
  taskUpdated?: boolean;
  error?: string;
}> {
  const course = (d.course ?? "").trim();
  const title = (d.title ?? "").trim();
  const body = (d.body ?? "").trim();
  if (!course || !title || body.length < 10) return { ok: false, error: "course/title/body が不足しています" };

  // 1) 授業フォルダへ md 保存（RAG登録は owui-sync に任せる）
  let savedTo: string | undefined;
  const root = env.notesExportDir;
  if (root) {
    const { matchCourseDir } = await import("./notes-export");
    const dirName = await matchCourseDir(root, course.normalize("NFKC"));
    const dir = path.join(root, dirName);
    await fs.mkdir(dir, { recursive: true });
    const safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    const md = [
      `# 【課題】${title}`,
      ``,
      `- 講義: ${course}`,
      d.due ? `- 締切: ${d.due}${d.dueTime ? ` ${d.dueTime}` : ""}` : "",
      d.grading ? `- 評価方法: ${d.grading}` : "",
      d.url ? `- 学情URL: ${d.url}` : "",
      ``,
      `## 課題内容（学情から取り込み）`,
      ``,
      body.slice(0, 50_000),
    ].filter((l) => l !== "").join("\n");
    savedTo = path.join(dir, `【課題】${safe}.md`);
    await fs.writeFile(savedTo, md);
    console.log(`[gakujo] 課題詳細を保存: ${savedTo}`);
  }

  // 2) 対応タスクの notes に要点を反映（タイトル包含で照合、NFKC揺れ吸収）
  let taskUpdated = false;
  const norm = (s: string) => s.normalize("NFKC");
  const open = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all()
    .filter((t) => norm(t.title ?? "").includes(norm(title)));
  for (const t of open.slice(0, 2)) {
    const head = body.slice(0, 1200);
    if ((t.notes ?? "").includes(head.slice(0, 80))) continue; // 反映済み
    try {
      const { updateTask } = await import("./mutations");
      await updateTask({
        account: t.account,
        tasklist: t.tasklist,
        id: t.googleId,
        notes: `${head}${body.length > 1200 ? "\n…（全文は授業資料フォルダの【課題】mdに保存済み）" : ""}`,
      });
      taskUpdated = true;
      console.log(`[gakujo] タスクに設問を反映: ${t.title}`);
    } catch (e) {
      console.log(`[gakujo] タスク更新失敗: ${String(e).slice(0, 120)}`);
    }
  }
  return { ok: true, savedTo, taskUpdated };
}
