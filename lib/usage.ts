import { gt } from "drizzle-orm";
import { db } from "./db";
import { agentJobs } from "./db/schema";
import type { AgentUsage } from "./agents-catalog";

/**
 * Aggregates the agent_jobs ledger into a usage report (tokens / cost / calls),
 * by day and by agent+model. Everything is best-effort: each CLI reports a
 * different subset (claude: tokens+USD, codex: total tokens, copilot: credits,
 * agy: nothing), so rows simply sum what exists.
 */

export interface UsageBucket {
  key: string; // "2026-07-03" or "claude / sonnet"
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number; // in+out when available, else the CLI's own total
  costUsd: number;
  credits: number;
  durationMs: number;
}

export interface UsageReport {
  days: number;
  byDay: UsageBucket[]; // newest first
  byModel: UsageBucket[]; // most-used first
  total: UsageBucket;
}

const pad = (n: number) => String(n).padStart(2, "0");

function emptyBucket(key: string): UsageBucket {
  return {
    key, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0,
    totalTokens: 0, costUsd: 0, credits: 0, durationMs: 0,
  };
}

function add(b: UsageBucket, u: AgentUsage | null, isError: boolean) {
  b.calls++;
  if (isError) b.errors++;
  if (!u) return;
  b.inputTokens += u.inputTokens ?? 0;
  b.outputTokens += u.outputTokens ?? 0;
  b.totalTokens +=
    u.inputTokens != null || u.outputTokens != null
      ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      : (u.totalTokens ?? 0);
  b.costUsd += u.costUsd ?? 0;
  b.credits += u.credits ?? 0;
  b.durationMs += u.durationMs ?? 0;
}

export function usageReport(days = 30): UsageReport {
  const since = Date.now() - days * 86_400_000;
  const rows = db
    .select({
      agent: agentJobs.agent,
      status: agentJobs.status,
      usage: agentJobs.usage,
      createdAt: agentJobs.createdAt,
    })
    .from(agentJobs)
    .where(gt(agentJobs.createdAt, since))
    .all();

  const byDay = new Map<string, UsageBucket>();
  const byModel = new Map<string, UsageBucket>();
  const total = emptyBucket("合計");

  for (const r of rows) {
    let u: AgentUsage | null = null;
    try {
      u = r.usage ? (JSON.parse(r.usage) as AgentUsage) : null;
    } catch {
      // corrupt usage JSON — count the call, skip the numbers
    }
    const isError = r.status === "error";
    const d = new Date(r.createdAt ?? 0);
    const dayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const modelKey = `${r.agent ?? "?"}${u?.model ? ` / ${u.model}` : ""}`;

    let day = byDay.get(dayKey);
    if (!day) byDay.set(dayKey, (day = emptyBucket(dayKey)));
    let model = byModel.get(modelKey);
    if (!model) byModel.set(modelKey, (model = emptyBucket(modelKey)));

    add(day, u, isError);
    add(model, u, isError);
    add(total, u, isError);
  }

  return {
    days,
    byDay: [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key)),
    byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    total,
  };
}
