/**
 * The local CLI agents the chat can use, and which model/effort knobs each one
 * exposes. Shared by the UI (selector options) and the server (validation of
 * untrusted request values), so keep it pure data — no Node imports.
 */

export type AgentName = "claude" | "codex" | "copilot" | "agy";

export interface ModelDef {
  id: string; // wire value; for agy this is antigravity's display name
  label: string;
  efforts?: string[]; // selectable reasoning efforts (absent = not tunable)
  defaultEffort?: string;
}

export const AGENT_CATALOG: Record<AgentName, { models: ModelDef[] }> = {
  claude: {
    models: [
      { id: "haiku", label: "haiku（軽い）" },
      { id: "sonnet", label: "sonnet（標準）" },
      { id: "opus", label: "opus（重い・計画向き）" },
    ],
  },
  codex: {
    // effort maps to codex's model_reasoning_effort config
    models: [
      { id: "gpt-5.5", label: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { id: "gpt-5.4", label: "gpt-5.4", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "gpt-5.4-mini", label: "gpt-5.4-mini", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
  },
  copilot: {
    // this account's plan only permits the auto picker; auto rejects --effort
    models: [{ id: "auto", label: "auto（自動選択）" }],
  },
  agy: {
    // antigravity bakes effort into the model name: "Gemini 3.5 Flash (High)"
    models: [
      { id: "Gemini 3.5 Flash", label: "Gemini 3.5 Flash", efforts: ["Low", "Medium", "High"], defaultEffort: "Medium" },
      { id: "Gemini 3.1 Pro", label: "Gemini 3.1 Pro", efforts: ["Low", "High"], defaultEffort: "High" },
      { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6" },
      { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6" },
      { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B" },
    ],
  },
};

export const AGENT_NAMES = Object.keys(AGENT_CATALOG) as AgentName[];

export function isAgentName(v: unknown): v is AgentName {
  return typeof v === "string" && v in AGENT_CATALOG;
}

/**
 * Best-effort usage stats for one agent invocation. Each CLI reports different
 * things: claude = exact tokens + USD, codex = total tokens only, copilot =
 * approximate tokens + AI credits, agy = nothing (duration only).
 */
export interface AgentUsage {
  model?: string;
  effort?: string;
  inputTokens?: number; // includes cached
  cachedTokens?: number;
  outputTokens?: number;
  totalTokens?: number; // when only a combined figure is known (codex)
  costUsd?: number; // claude
  credits?: number; // copilot AI credits
  durationMs?: number; // wall time of the CLI call
}

export interface AgentChoice {
  agent: AgentName;
  model?: string;
  effort?: string;
}

/** Clamp untrusted agent/model/effort to catalog values (unknown → CLI defaults). */
export function normalizeChoice(agent?: unknown, model?: unknown, effort?: unknown): AgentChoice {
  const a: AgentName = isAgentName(agent) ? agent : "claude";
  const m = AGENT_CATALOG[a].models.find((x) => x.id === model);
  if (!m) return { agent: a };
  const e =
    m.efforts && m.efforts.includes(effort as string)
      ? (effort as string)
      : m.defaultEffort;
  return { agent: a, model: m.id, effort: e };
}
