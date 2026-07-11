import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_CATALOG, type AgentName, type ModelDef } from "./agents-catalog";

/**
 * ライブモデルカタログ: agents-catalog.ts の静的定義を「今使えるモデル」で
 * 上書きする（取得できない時は静的定義のまま）。モデルの世代交代を
 * ハードコード修正なしで UI (Kairos AIチャット / mnemo bridge) に反映する。
 *
 * - codex: CLI 自身が ~/.codex/models_cache.json を自動更新している → それを読む
 * - claude: /v1/models API（Claude Code の OAuth トークンで叩ける）
 * - copilot / agy: 一覧手段がないので静的のまま
 */

const CLAUDE_DIRS = (process.env.KAIROS_CLAUDE_DIRS ?? process.env.MNEMO_CLAUDE_DIRS ?? `${os.homedir()}/.claude:${os.homedir()}/.claude-b`)
  .split(":")
  .filter(Boolean);

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const TTL_MS = 10 * 60_000;

let cache: { at: number; cat: Record<AgentName, { models: ModelDef[] }> } | null = null;

async function codexModels(): Promise<ModelDef[]> {
  const raw = await fs.readFile(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8");
  const d = JSON.parse(raw) as {
    models?: {
      slug: string;
      display_name?: string;
      visibility?: string;
      default_reasoning_level?: string;
      supported_reasoning_levels?: { effort: string }[];
    }[];
  };
  return (d.models ?? [])
    .filter((m) => m.visibility === "list")
    .map((m) => ({
      id: m.slug,
      label: m.display_name ?? m.slug,
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
      defaultEffort: m.default_reasoning_level,
    }));
}

async function claudeToken(): Promise<string | null> {
  for (const dir of CLAUDE_DIRS) {
    try {
      const c = JSON.parse(await fs.readFile(path.join(dir, ".credentials.json"), "utf8"));
      const t = c?.claudeAiOauth?.accessToken;
      if (typeof t === "string" && t) return t;
    } catch { /* 未ログインdir */ }
  }
  return null;
}

async function claudeModels(): Promise<ModelDef[]> {
  const token = await claudeToken();
  if (!token) return [];
  const r = await fetch("https://api.anthropic.com/v1/models?limit=20", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) return [];
  const d = (await r.json()) as {
    data?: {
      id: string;
      display_name?: string;
      created_at?: string;
      capabilities?: { effort?: Record<string, { supported?: boolean } | boolean | undefined> };
    }[];
  };
  const rows = (d.data ?? [])
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, 8);
  return rows.map((m) => {
    const cap = m.capabilities?.effort;
    const efforts = cap
      ? CLAUDE_EFFORT_LEVELS.filter((l) => {
          const v = cap[l];
          return typeof v === "object" ? v?.supported : !!v;
        })
      : CLAUDE_EFFORT_LEVELS;
    return {
      id: m.id,
      label: m.display_name ?? m.id,
      efforts: efforts.length > 0 ? efforts : CLAUDE_EFFORT_LEVELS,
      defaultEffort: "medium",
    };
  });
}

/**
 * claude はエイリアス(haiku/sonnet/opus/fable = 常に最新世代)を先頭に残し、
 * ラベルだけライブの表示名に更新。ピン留め用の全モデルidを後ろに並べる。
 * （localStorageに保存済みの "sonnet" 等の選択が生き続けるように）
 */
function mergeClaude(live: ModelDef[]): ModelDef[] {
  const ALIASES: { id: string; defaultEffort: string }[] = [
    { id: "haiku", defaultEffort: "medium" },
    { id: "sonnet", defaultEffort: "medium" },
    { id: "opus", defaultEffort: "high" },
    { id: "fable", defaultEffort: "high" },
  ];
  const heads: ModelDef[] = [];
  for (const a of ALIASES) {
    const hit = live.find((m) => m.id.startsWith(`claude-${a.id}`)); // liveは新しい順
    if (!hit) continue;
    heads.push({ id: a.id, label: `${hit.label}（最新）`, efforts: hit.efforts, defaultEffort: a.defaultEffort });
  }
  return heads.length > 0 ? [...heads, ...live] : live;
}

/** 静的カタログ + ライブ情報のマージ（10分キャッシュ、全て失敗時は静的のまま）。 */
export async function liveAgentCatalog(): Promise<Record<AgentName, { models: ModelDef[] }>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cat;
  const cat: Record<AgentName, { models: ModelDef[] }> = JSON.parse(JSON.stringify(AGENT_CATALOG));
  const [codex, claude] = await Promise.all([
    codexModels().catch(() => [] as ModelDef[]),
    claudeModels().catch(() => [] as ModelDef[]),
  ]);
  if (codex.length > 0) cat.codex.models = codex;
  if (claude.length > 0) cat.claude.models = mergeClaude(claude);
  cache = { at: Date.now(), cat };
  return cat;
}
