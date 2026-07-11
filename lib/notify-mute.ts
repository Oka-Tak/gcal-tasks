import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { env } from "./env";

/**
 * 通知ミュート: タイトルにキーワードを含む予定・タスクをプッシュ通知から
 * 除外する（SecHack等「自分向けでない」共有カレンダーの予定対策）。
 * 対象 = 朝ブリーフィングの予定/締切リスト・期限前日ナッジ・分割提案・
 * 締切1時間前/到来プッシュ。ユーザーが明示的に設定したリマインダー
 * (remindAt) は意図された通知なのでミュートしない。
 * 保存先 data/notify-mute.json、設定UIはアカウントモーダルの通知欄。
 */

const FILE = () => path.join(path.resolve(env.dataDir), "notify-mute.json");

export function loadMuteKeywords(): string[] {
  try {
    const j = JSON.parse(fsSync.readFileSync(FILE(), "utf8")) as { keywords?: unknown };
    if (!Array.isArray(j.keywords)) return [];
    return j.keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "");
  } catch {
    return [];
  }
}

export async function saveMuteKeywords(keywords: string[]): Promise<string[]> {
  const clean = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 100);
  await fs.mkdir(path.dirname(FILE()), { recursive: true });
  await fs.writeFile(FILE(), JSON.stringify({ keywords: clean }, null, 1));
  return clean;
}

// 全角/半角・大文字小文字の揺れを吸収（"SecHack" ≒ "sechack" ≒ "ＳｅｃＨａｃｋ"）
const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** 1回の通知チェックの間つかい回す判定関数を返す（ファイル読みは1度だけ）。 */
export function muteMatcher(): (title: string | null | undefined) => boolean {
  const keys = loadMuteKeywords().map(norm);
  if (keys.length === 0) return () => false;
  return (title) => {
    if (!title) return false;
    const t = norm(title);
    return keys.some((k) => t.includes(k));
  };
}
