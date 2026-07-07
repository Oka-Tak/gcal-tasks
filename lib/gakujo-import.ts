import crypto from "node:crypto";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "./db";
import { tasklists, tasks } from "./db/schema";
import { runAgent, extractJson } from "./agent";
import { createTask } from "./mutations";

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

export async function importGakujoAssignments(text: string): Promise<ImportResult> {
  const empty: ImportResult = { ok: true, created: 0, skipped: 0, pastOrDone: 0, noDue: 0, items: [] };
  if (!text || text.length < 20) return { ...empty, ok: false, error: "本文が空です" };

  const res = await runAgent(extractPrompt(text), { agent: "claude", model: "haiku", jobKind: "gakujo-import", timeoutMs: 120_000 });
  if (!res.ok) return { ...empty, ok: false, error: `抽出失敗: ${res.error}` };
  const list = extractJson<Assignment[]>(res.text);
  if (!Array.isArray(list)) return { ...empty, ok: false, error: "抽出結果をJSONとして解釈できませんでした" };

  const target = targetList();
  if (!target) return { ...empty, ok: false, error: "書き込み先タスクリストがありません（Googleアカウント連携を確認）" };

  const today = new Date().toISOString().slice(0, 10);
  const out: ImportResult = { ...empty, items: [] };
  for (const a of list.slice(0, 60)) {
    const title = `【課題】${a.course ? `${a.course}: ` : ""}${a.title ?? "(無題)"}`;
    if (a.submitted) { out.pastOrDone++; out.items.push({ title, due: a.due ?? null, status: "past-or-done" }); continue; }
    if (!a.due || !/^\d{4}-\d{2}-\d{2}$/.test(a.due)) { out.noDue++; out.items.push({ title, due: null, status: "no-due" }); continue; }
    if (a.due < today) { out.pastOrDone++; out.items.push({ title, due: a.due, status: "past-or-done" }); continue; }

    const key = keyOf(a);
    const dup = db.select({ id: tasks.googleId }).from(tasks)
      .where(and(isNull(tasks.deletedAt), like(tasks.notes, `%[gakujo:${key}]%`))).get();
    if (dup) { out.skipped++; out.items.push({ title, due: a.due, status: "skipped" }); continue; }

    try {
      await createTask({
        account: target.account,
        tasklist: target.tasklist,
        title,
        notes: `学務情報システムの課題（自動取り込み）\n[gakujo:${key}]`,
        due: a.due,
        ...(a.dueTime && /^\d{2}:\d{2}$/.test(a.dueTime) ? { dueTime: a.dueTime } : {}),
      });
      out.created++;
      out.items.push({ title, due: a.due, status: "created" });
    } catch (e) {
      out.items.push({ title, due: a.due, status: "skipped" });
      console.error("[gakujo-import] createTask failed:", String(e).slice(0, 200));
    }
  }
  return out;
}
