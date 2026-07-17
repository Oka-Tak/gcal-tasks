import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import type { AgentName } from "./agents-catalog";

/**
 * エージェント優先順位の設定（data/agent-priority.json）。
 * runAgentAuto のフォールバック順をここで決める — claude が limit のとき／
 * 将来 他社LLM・ローカルLLM へ移行するときは、この並びを変えるだけで
 * 全バックグラウンド機能（要約・推定・取り込み等）が追随する。
 * 詳細: docs/AGENT-FALLBACK.md
 */

export interface PriorityStep {
  agent: AgentName;
  model?: string; // 省略時: claudeは呼び出し側指定を引き継ぐ / 他はCLI既定
  effort?: string;
}

export interface PriorityConfig {
  order: PriorityStep[];
  probe: boolean; // 各段の実行前に最安モデルで生存確認（10分キャッシュ）
}

const FILE = () => path.join(path.resolve(env.dataDir), "agent-priority.json");

export const DEFAULT_PRIORITY: PriorityConfig = {
  order: [
    { agent: "claude" }, // model/effort は呼び出し側指定を引き継ぐ
    { agent: "codex", model: "gpt-5.4-mini", effort: "medium" },
    { agent: "copilot", model: "auto" },
    { agent: "agy", model: "Gemini 3.5 Flash", effort: "Medium" },
  ],
  probe: true,
};

const KNOWN: AgentName[] = ["claude", "codex", "copilot", "agy"];

const g = globalThis as unknown as { __kairosPriority?: { at: number; cfg: PriorityConfig } };

/** 設定を読む（30秒キャッシュ。無ければ既定）。 */
export function loadPriority(): PriorityConfig {
  if (g.__kairosPriority && Date.now() - g.__kairosPriority.at < 30_000) return g.__kairosPriority.cfg;
  let cfg = DEFAULT_PRIORITY;
  try {
    const j = JSON.parse(fsSync.readFileSync(FILE(), "utf8")) as Partial<PriorityConfig>;
    const order = (j.order ?? [])
      .filter((s): s is PriorityStep => !!s && KNOWN.includes(s.agent))
      .slice(0, 8);
    if (order.length > 0) cfg = { order, probe: j.probe !== false };
  } catch { /* 未作成 = 既定 */ }
  g.__kairosPriority = { at: Date.now(), cfg };
  return cfg;
}

/**
 * 並び替え保存。names はエージェント名の順序（例 ["codex","claude"]）。
 * 各段の model/effort は既存設定 > 既定 から引き継ぐ。
 */
export async function savePriorityOrder(names: string[], probe?: boolean): Promise<PriorityConfig> {
  const current = loadPriority();
  const lookup = new Map<string, PriorityStep>();
  for (const s of [...current.order, ...DEFAULT_PRIORITY.order]) {
    if (!lookup.has(s.agent)) lookup.set(s.agent, s);
  }
  const order: PriorityStep[] = [];
  for (const raw of names) {
    const name = raw.trim().toLowerCase() as AgentName;
    if (!KNOWN.includes(name) || order.some((s) => s.agent === name)) continue;
    order.push(lookup.get(name) ?? { agent: name });
  }
  if (order.length === 0) throw new Error(`有効なエージェント名がありません（${KNOWN.join(", ")}）`);
  const cfg: PriorityConfig = { order, probe: probe ?? current.probe };
  await fs.mkdir(path.dirname(FILE()), { recursive: true });
  await fs.writeFile(FILE(), JSON.stringify(cfg, null, 1));
  g.__kairosPriority = { at: Date.now(), cfg };
  return cfg;
}
