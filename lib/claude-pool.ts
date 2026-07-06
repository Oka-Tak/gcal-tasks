import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Claude 複数アカウントのプール: KAIROS_CLAUDE_DIRS（コロン区切りの
 * CLAUDE_CONFIG_DIR 群、既定 ~/.claude:~/.claude-b）のうち、資格情報が
 * 存在するものを対象に、OAuth usage API で【5時間枠の残量】が多い方を選ぶ。
 * 2つ目のディレクトリが未ログインなら自動的に1アカウント運用になる。
 * 選択は60秒キャッシュ。全照会が失敗したら undefined（CLI既定の ~/.claude）。
 */

const HOME = os.homedir();
export const CLAUDE_DIRS = (process.env.KAIROS_CLAUDE_DIRS ?? `${HOME}/.claude:${HOME}/.claude-b`)
  .split(":")
  .map((s) => s.trim())
  .filter(Boolean);

export interface ClaudeAccount {
  dir: string;
  label: string; // "claude" / "claude②" …
  remaining: number | null; // 5時間枠の残り% (取得失敗は null)
  plan?: string;
}

const g = globalThis as unknown as {
  __claudePool?: { at: number; accounts: ClaudeAccount[] };
};

const MARKS = ["", "②", "③", "④"];

async function probe(dir: string, i: number): Promise<ClaudeAccount | null> {
  let token = "";
  let plan: string | undefined;
  try {
    const cred = JSON.parse(await fs.readFile(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth ?? {};
    token = cred.accessToken ?? "";
    plan = cred.subscriptionType;
  } catch {
    return null; // 未ログインのディレクトリはプール外
  }
  if (!token) return null;
  const acct: ClaudeAccount = { dir, label: `claude${MARKS[i] ?? `#${i + 1}`}`, remaining: null, plan };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const d = (await res.json()) as { limits?: { kind: string; percent: number }[] };
      const session = (d.limits ?? []).find((l) => l.kind === "session");
      if (session) acct.remaining = Math.max(0, 100 - session.percent);
    }
  } catch { /* 残量不明のまま (期限切れトークン等) — 候補としては残す */ }
  return acct;
}

/** ログイン済みアカウント一覧（残量つき、60sキャッシュ）。 */
export async function claudeAccounts(): Promise<ClaudeAccount[]> {
  if (g.__claudePool && Date.now() - g.__claudePool.at < 60_000) return g.__claudePool.accounts;
  const accounts = (await Promise.all(CLAUDE_DIRS.map((d, i) => probe(d, i))))
    .filter((a): a is ClaudeAccount => !!a);
  g.__claudePool = { at: Date.now(), accounts };
  return accounts;
}

/**
 * 実行に使う CLAUDE_CONFIG_DIR を返す。単一アカウントなら undefined
 * （= CLI 既定動作）。複数なら5時間枠の残りが最大のものを選ぶ。
 */
export async function pickClaudeDir(): Promise<string | undefined> {
  try {
    const accounts = await claudeAccounts();
    if (accounts.length < 2) return undefined;
    const ranked = [...accounts].sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1));
    const pick = ranked[0];
    if (pick.remaining != null && pick.remaining < 3) {
      // 全アカウント枯渇級 — それでも最大を返す（CLIがエラーを返すのはそのアカウント）
      console.warn(`[claude-pool] all accounts nearly exhausted (best: ${pick.label} ${pick.remaining}%)`);
    }
    return pick.dir;
  } catch {
    return undefined;
  }
}
