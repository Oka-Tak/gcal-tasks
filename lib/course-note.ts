import crypto from "node:crypto";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { notes } from "./db/schema";
import { env } from "./env";
import { runAgentAuto } from "./agent";
import { bindNoteToFolder, collectCourseExtras } from "./folder-notes";
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

/**
 * 過去問が大量にある授業向けの事前圧縮（2段階の1段目）。年度ごとに問題文を
 * まとめて haiku low で「頻出テーマ・典型問題・解答方針」に要約し、総まとめの
 * プロンプトに収まるサイズにする。少量ならそのまま原文を返す。
 */
async function digestExams(
  course: string,
  exams: { name: string; year: string; num: number; text: string }[],
): Promise<string> {
  const totalChars = exams.reduce((s, e) => s + e.text.length, 0);
  if (exams.length === 0) return "";
  // 小規模ならそのまま（原文の方が正確）
  if (totalChars <= 40_000) {
    return exams.map((e) => `### ${e.year} ${e.name}\n${e.text.slice(0, 8000)}`).join("\n\n");
  }
  // 西暦でグループ化して各年度を個別要約（令和5とR5等の表記揺れを統合）
  const byYear = new Map<number, typeof exams>();
  for (const e of exams) {
    const k = e.num;
    (byYear.get(k) ?? byYear.set(k, []).get(k)!).push(e);
  }
  const digests: string[] = [];
  for (const [, items] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
    const year = items[0].year;
    const body = items.map((i) => `【${i.name}】\n${i.text.slice(0, 12_000)}`).join("\n\n").slice(0, 40_000);
    const res = await runAgentAuto(
      [
        `次は大学「${course}」の${year}の過去問（試験問題・解答例を含む）です。`,
        "試験対策のため、出題テーマ・具体的な設問・押さえるべき知識/解答方針を、箇条書きで簡潔に抽出してください。",
        "SQLやER図・正規化など記述問題は、問われ方と解答のコツも書く。捏造しない。Markdown箇条書きのみ出力。",
        "",
        body,
      ].join("\n"),
      { model: "haiku", effort: "low", jobKind: "exam-digest", timeoutMs: 300_000 },
    );
    if (res.ok && res.text.trim()) digests.push(`### ${year}\n${res.text.trim()}`);
  }
  return digests.join("\n\n");
}

function buildPrompt(
  course: string,
  parts: { title: string; content: string }[],
  general: { name: string; text: string }[],
  examsDigest: string,
  examImages: number,
  glossary: string,
): string {
  return [
    `あなたは大学生の学習アシスタント。授業「${course}」の各回の講義ノート（要約）と、`,
    "回に紐付かない全体資料（課題・過去問・小テスト・シラバス・配布資料など）を渡すので、",
    "期末テスト対策のための総まとめノートを日本語のMarkdownで作ってください。",
    "構成:",
    "1. 冒頭に「## この授業の全体像」— 何を学ぶ授業か、各回がどうつながるかを5行以内で。",
    "2. 「## 各回の要点」— 回ごとに見出し+要点2〜4行（試験に出そうな概念を優先）。",
    "3. 「## 重要用語集」— 横断的に重要な用語を1行ずつ（用語: 簡潔な定義）。",
    "4. 「## 出題されそうなポイント・チェックリスト」— 教員が強調した点・課題やテスト言及・比較させられそうな概念対比を箇条書き。",
    examsDigest
      ? "5. 「## 過去問の傾向と頻出テーマ」— 提示する過去問（複数年度）を横断し、毎年出るテーマ・典型的な設問形式（記述/計算/SQL/ER図/正規化等）・解答の型を整理する。複数年で繰り返される論点は【頻出】と明示。年度ごとの羅列ではなくテーマ別にまとめること。"
      : "5. 全体資料に課題があれば「## 課題の要点」節を作り、各設問の主旨と押さえるべき知識を整理する。",
    "6. あれば「## 未消化・要復習」— ノートから理解が薄そうな箇所。",
    "捏造しない（ノート・資料に無いことを試験範囲と断定しない）。テストや課題への言及は特に拾うこと。",
    examImages > 0 ? `※ 画像形式の過去問が${examImages}枚あり本文未読。総まとめ末尾に「※画像の過去問${examImages}枚は未取り込み」と注記すること。` : "",
    "ツールは使わない。Markdown本文だけを出力（前置き・コードフェンス不要）。",
    ...(glossary ? ["", "# 用語集（ユーザー固有の用語）", glossary] : []),
    "",
    ...(examsDigest ? ["# 過去問（年度横断の要点）", examsDigest, ""] : []),
    ...(general.length
      ? ["# 全体資料（課題・シラバス等 — 回に紐付かない）", ...general.map((g) => `## ${g.name}\n${g.text}`), ""]
      : []),
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

  // 資料収集(PDF抽出)・過去問digest(LLM×年度)・生成はすべてバックグラウンド。
  // POSTは即返す（過去問digestは数分かかるので同期待ちするとタイムアウトする）。
  void (async () => {
    try {
      // 回に紐付かない全体資料（課題・シラバス）と過去問（再帰収集）
      const extras = await collectCourseExtras(course).catch(() => ({ general: [], exams: [], examImages: 0 }));
      if (parts.length === 0 && extras.general.length === 0 && extras.exams.length === 0) {
        db.update(notes).set({ status: "error", error: "完成したノートも資料もありません", updatedAt: Date.now() }).where(eq(notes.id, id)).run();
        return;
      }
      // 過去問が多い授業は年度ごとに事前要約してから総まとめへ（2段階）
      const examsDigest = await digestExams(course, extras.exams).catch((e) => {
        console.log(`[course-note] exam digest failed: ${String(e).slice(0, 120)}`);
        return "";
      });
      const res = await runAgentAuto(buildPrompt(course, parts, extras.general, examsDigest, extras.examImages, glossaryBlock(1500)), {
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
      console.log(`[course-note] 総まとめ生成: ${title}（${parts.length}回分 + 全体資料${extras.general.length}件 + 過去問${extras.exams.length}件/画像${extras.examImages}枚）`);
    } catch (e) {
      db.update(notes).set({ status: "error", error: String(e).slice(0, 500), updatedAt: Date.now() }).where(eq(notes.id, id)).run();
    }
  })();
  return id;
}
