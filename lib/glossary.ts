import crypto from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "./db";
import { glossary } from "./db/schema";
import { pushNoteToOwui } from "./owui";

/**
 * ユーザー固有の専門用語・団体・略語の管理。AIの誤解防止のため:
 *  - Kairosチャット / タスクAI推定 / mnemoブリッジ のプロンプトに注入
 *  - OWUIのRAGに「kairos-note-glossary.md」1ファイルとして登録（保存のたび置換）
 * definition が「（編集してください）」のうちはプロンプトに入れない（雑音防止）。
 */

export type GlossaryRow = typeof glossary.$inferSelect;

const PLACEHOLDER = "（編集してください）";

export function listGlossary(): GlossaryRow[] {
  return db.select().from(glossary).orderBy(asc(glossary.term)).all();
}

export function upsertGlossary(w: { id?: string; term: string; aliases?: string | null; definition?: string | null }): GlossaryRow {
  if (!w.term?.trim()) throw new Error("term が必要です");
  const now = Date.now();
  const id = w.id ?? crypto.randomUUID();
  const existing = w.id ? db.select().from(glossary).where(eq(glossary.id, w.id)).get() : null;
  const row = {
    id,
    term: w.term.trim(),
    aliases: w.aliases?.trim() || null,
    definition: w.definition?.trim() || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) db.update(glossary).set(row).where(eq(glossary.id, id)).run();
  else db.insert(glossary).values(row).run();
  return db.select().from(glossary).where(eq(glossary.id, id)).get()!;
}

export function deleteGlossary(id: string): void {
  db.delete(glossary).where(eq(glossary.id, id)).run();
}

/** プロンプト注入用の圧縮ブロック（プレースホルダは除外、文字数上限つき）。 */
export function glossaryBlock(maxChars = 2000): string {
  const lines: string[] = [];
  for (const g of listGlossary()) {
    if (!g.definition || g.definition.includes(PLACEHOLDER)) continue;
    lines.push(`- ${g.term}${g.aliases ? `（${g.aliases}）` : ""}: ${g.definition}`);
  }
  if (lines.length === 0) return "";
  let out = "";
  for (const l of lines) {
    if (out.length + l.length > maxChars) break;
    out += (out ? "\n" : "") + l;
  }
  return out;
}

/** RAG用にOWUIへ1ファイルで登録（kairos-note-glossary.md を毎回置換）。 */
export async function pushGlossaryToOwui(): Promise<void> {
  const rows = listGlossary().filter((g) => g.definition && !g.definition.includes(PLACEHOLDER));
  if (rows.length === 0) return;
  const md = rows.map((g) => `## ${g.term}${g.aliases ? `（${g.aliases}）` : ""}\n${g.definition}`).join("\n\n");
  await pushNoteToOwui(
    { id: "glossary", title: "用語集（ユーザー固有の専門用語・団体）", content: md, transcript: null },
    null, // 既定コレクション — RAGは全コレクション横断なのでどこでも拾われる
  );
}

/** 初回だけの種まき。不明な用語はプレースホルダで置き、UIから編集してもらう。 */
export function seedGlossary(): void {
  if (listGlossary().length > 0) return;
  const seed: { term: string; aliases?: string; definition: string }[] = [
    { term: "SecHack365", definition: "NICT主催の1年間のセキュリティイノベーター育成プログラム。参加中。" },
    { term: "学情", aliases: "学務情報システム, gakujo", definition: "静岡大学の学務情報システム。課題・履修・お知らせの確認に使う。" },
    { term: "調整さん", definition: "日程調整のWebサービス。サークル等の定例会の日程決めに使う。" },
    { term: "狩野研", aliases: "狩野研究室", definition: "所属している研究室（先端情報学実習の受け入れ先）。" },
    { term: "TRS", definition: PLACEHOLDER },
    { term: "セキュ活", definition: PLACEHOLDER },
    { term: "Cue-FM", definition: PLACEHOLDER },
    { term: "JINGS", definition: PLACEHOLDER },
    { term: "静大祭", definition: "静岡大学の大学祭。" },
  ];
  for (const s of seed) upsertGlossary(s);
}
