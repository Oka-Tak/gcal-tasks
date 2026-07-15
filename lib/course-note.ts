import crypto from "node:crypto";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { notes } from "./db/schema";
import { env } from "./env";
import { runAgentAuto } from "./agent";
import { bindNoteToFolder } from "./folder-notes";
import { courseView } from "./course-sessions";
import { glossaryBlock } from "./glossary";
import { exportNoteFiles } from "./notes-export";
import { pushNoteToOwui } from "./owui";

/**
 * 授業全体の総まとめノート（テスト対策）: その授業の全回のノートを横断して
 * 1本の試験対策ノートを生成する。回別ノートと同じく RAG（講義: X）に登録し、
 * 授業フォルダ直下に md を書き出す（フォルダ台帳に授業ルートで紐付け —
 * 回別スキャンは2階層しか見ないので誤検出しない）。
 * 再実行すると同じノートを作り直す（増殖しない）。
 */

const TITLE_SUFFIX = " 総まとめ（テスト対策）";

export function summaryTitleOf(course: string): string {
  return `${course}${TITLE_SUFFIX}`;
}

function buildPrompt(course: string, parts: { title: string; content: string }[], glossary: string): string {
  return [
    `あなたは大学生の学習アシスタント。授業「${course}」の各回の講義ノート（要約）を渡すので、`,
    "期末テスト対策のための総まとめノートを日本語のMarkdownで作ってください。",
    "構成:",
    "1. 冒頭に「## この授業の全体像」— 何を学ぶ授業か、各回がどうつながるかを5行以内で。",
    "2. 「## 各回の要点」— 回ごとに見出し+要点2〜4行（試験に出そうな概念を優先）。",
    "3. 「## 重要用語集」— 横断的に重要な用語を1行ずつ（用語: 簡潔な定義）。",
    "4. 「## 出題されそうなポイント・チェックリスト」— 教員が強調した点・課題やテスト言及・比較させられそうな概念対比を箇条書き。",
    "5. あれば「## 未消化・要復習」— ノートから理解が薄そうな箇所。",
    "捏造しない（ノートに無いことを試験範囲と断定しない）。テストや課題への言及は特に拾うこと。",
    "ツールは使わない。Markdown本文だけを出力（前置き・コードフェンス不要）。",
    ...(glossary ? ["", "# 用語集（ユーザー固有の用語）", glossary] : []),
    "",
    ...parts.map((p) => `# ${p.title}\n${p.content}`),
  ].join("\n");
}

/** 総まとめノートを生成（既存があれば同じノートを更新）。返り値は noteId。 */
export async function generateCourseSummary(course: string): Promise<string> {
  const view = await courseView(course);
  const parts: { title: string; content: string }[] = [];
  for (const s of view.sessions) {
    if (!s.noteId) continue;
    const r = db.select().from(notes).where(eq(notes.id, s.noteId)).get();
    if (!r || r.deletedAt || r.status !== "done" || !r.content?.trim()) continue;
    parts.push({ title: r.title ?? s.folder ?? s.ymd, content: r.content.trim().slice(0, 3500) });
  }
  if (parts.length === 0) throw new Error("この授業にはまだ完成したノートがありません");

  const notebook = `講義: ${course}`;
  const title = summaryTitleOf(course);
  const existing = db
    .select()
    .from(notes)
    .where(and(isNull(notes.deletedAt), eq(notes.title, title)))
    .get();
  const id = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  if (existing) {
    db.update(notes).set({ status: "summarizing", error: null, updatedAt: now }).where(eq(notes.id, id)).run();
  } else {
    db.insert(notes).values({ id, title, notebook, status: "summarizing", createdAt: now, updatedAt: now }).run();
  }
  // 授業フォルダ直下に紐付け（md書き出し先の固定 + カードのソース数）
  if (env.notesExportDir) await bindNoteToFolder(id, path.join(env.notesExportDir, course)).catch(() => {});

  // 生成はバックグラウンド（UIはノートを開いてポーリング）
  void (async () => {
    try {
      const res = await runAgentAuto(buildPrompt(course, parts, glossaryBlock(1500)), {
        jobKind: "course-summary",
        timeoutMs: 600_000,
      });
      if (!res.ok) {
        db.update(notes).set({ status: "error", error: `生成失敗: ${res.error}`.slice(0, 500), updatedAt: Date.now() }).where(eq(notes.id, id)).run();
        return;
      }
      const content = res.text.trim().slice(0, 200_000);
      db.update(notes)
        .set({ status: "done", content, error: null, jobId: res.jobId, updatedAt: Date.now() })
        .where(eq(notes.id, id))
        .run();
      const fresh = db.select().from(notes).where(eq(notes.id, id)).get()!;
      void pushNoteToOwui({ id, title, content, transcript: null }, notebook, fresh.owuiFileId).then((fid) => {
        if (fid) db.update(notes).set({ owuiFileId: fid }).where(eq(notes.id, id)).run();
      });
      void exportNoteFiles(fresh, Date.now()).catch((e) => console.log(`[course-note] export failed: ${e}`));
      console.log(`[course-note] 総まとめ生成: ${title}（${parts.length}回分）`);
    } catch (e) {
      db.update(notes).set({ status: "error", error: String(e).slice(0, 500), updatedAt: Date.now() }).where(eq(notes.id, id)).run();
    }
  })();
  return id;
}
