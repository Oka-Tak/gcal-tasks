import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CLAUDE_DIRS } from "./claude-pool";

/**
 * Best-effort "remaining quota" per CLI agent, read from each tool's own
 * plumbing (no tokens ever leave this box; only derived percentages are
 * returned to the UI):
 *  - claude:  Anthropic OAuth usage endpoint via ~/.claude/.credentials.json
 *  - codex:   last rate_limits snapshot in ~/.codex/sessions rollout JSONL
 *             (as of the last codex run — codex has no query-only API)
 *  - copilot: `gh api /copilot_internal/user` quota_snapshots
 *  - agy:     nothing exposed locally → always an error entry
 */

export interface QuotaLimit {
  label: string; // e.g. "5時間枠"
  remainingPercent: number; // 0–100
  resetsAt?: number | null; // epoch ms
  detail?: string; // e.g. "残り195/200回"
}

export interface AgentQuota {
  agent: string;
  plan?: string;
  asOf?: number | null; // when this snapshot was taken (epoch ms), if stale-able
  limits: QuotaLimit[];
  error?: string;
}

const HOME = os.homedir();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref()),
  ]);
}

/* ------------------------------------------------------------------ claude */
async function claudeQuota(dir = path.join(HOME, ".claude"), label = "claude"): Promise<AgentQuota> {
  const agent = label;
  try {
    const raw = await fs.readFile(path.join(dir, ".credentials.json"), "utf8");
    const cred = JSON.parse(raw).claudeAiOauth ?? {};
    if (!cred.accessToken) throw new Error("no token");
    const res = await withTimeout(
      fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${cred.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      }),
      6000,
    );
    if (!res.ok) {
      // expired token refreshes itself the next time the claude CLI runs
      return { agent, limits: [], error: `HTTP ${res.status}（claude を1回使うとトークンが更新されます）` };
    }
    const d = (await res.json()) as {
      limits?: { kind: string; percent: number; resets_at: string | null }[];
    };
    const LABEL: Record<string, string> = {
      session: "5時間枠",
      weekly_all: "週間（全体）",
      weekly_scoped: "週間（上位モデル）",
    };
    const limits: QuotaLimit[] = (d.limits ?? [])
      .filter((l) => LABEL[l.kind])
      .map((l) => ({
        label: LABEL[l.kind],
        remainingPercent: Math.max(0, 100 - l.percent),
        resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
      }));
    return { agent, plan: cred.subscriptionType, limits };
  } catch (e) {
    return { agent, limits: [], error: String(e).slice(0, 120) };
  }
}

/* ------------------------------------------------------------------- codex */
interface CodexRate {
  used_percent: number;
  window_minutes: number;
  resets_at: number; // epoch seconds
}

async function codexQuota(): Promise<AgentQuota> {
  const agent = "codex";
  try {
    const base = path.join(HOME, ".codex", "sessions");
    // rollout files live under sessions/YYYY/MM/DD/; walk and keep the newest few
    const files: { p: string; m: number }[] = [];
    const walk = async (dir: string, depth: number) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory() && depth < 3) await walk(p, depth + 1);
        else if (ent.isFile() && ent.name.endsWith(".jsonl"))
          files.push({ p, m: (await fs.stat(p)).mtimeMs });
      }
    };
    await walk(base, 0);
    files.sort((a, b) => b.m - a.m);

    for (const f of files.slice(0, 5)) {
      const lines = (await fs.readFile(f.p, "utf8")).split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        try {
          const row = JSON.parse(lines[i]);
          const rl = row?.payload?.rate_limits ?? row?.payload?.info?.rate_limits;
          if (!rl) continue;
          const lim = (r: CodexRate | null, label: string): QuotaLimit[] =>
            r ? [{
              label,
              remainingPercent: Math.max(0, 100 - r.used_percent),
              resetsAt: r.resets_at ? r.resets_at * 1000 : null,
            }] : [];
          return {
            agent,
            plan: rl.plan_type,
            asOf: row.timestamp ? Date.parse(row.timestamp) : f.m,
            limits: [
              ...lim(rl.primary, "5時間枠"),
              ...lim(rl.secondary, "週間"),
            ],
          };
        } catch { /* malformed line — keep scanning */ }
      }
    }
    return { agent, limits: [], error: "記録なし（codex を1回使うと取れます）" };
  } catch (e) {
    return { agent, limits: [], error: String(e).slice(0, 120) };
  }
}

/* ----------------------------------------------------------------- copilot */
async function copilotQuota(): Promise<AgentQuota> {
  const agent = "copilot";
  try {
    const out = await withTimeout(
      new Promise<string>((resolve, reject) => {
        const child = spawn("gh", ["api", "/copilot_internal/user"], { env: process.env });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (c) => (c === 0 ? resolve(stdout) : reject(new Error(stderr.slice(0, 120)))));
      }),
      8000,
    );
    const d = JSON.parse(out);
    const snaps = d.quota_snapshots ?? {};
    const LABEL: Record<string, string> = {
      premium_interactions: "プレミアムリクエスト（月）",
      chat: "チャット",
      completions: "補完",
    };
    const limits: QuotaLimit[] = [];
    const resetMs = d.quota_reset_date ? Date.parse(`${d.quota_reset_date}T00:00:00`) : null;
    for (const [id, s] of Object.entries(snaps) as [string, Record<string, unknown>][]) {
      if (!LABEL[id]) continue;
      if (s.unlimited) {
        limits.push({ label: LABEL[id], remainingPercent: 100, detail: "無制限" });
      } else {
        limits.push({
          label: LABEL[id],
          remainingPercent: Math.max(0, Number(s.percent_remaining ?? 0)),
          resetsAt: resetMs,
          detail: s.remaining != null && s.entitlement != null
            ? `残り${s.remaining}/${s.entitlement}回` : undefined,
        });
      }
    }
    return { agent, plan: [d.copilot_plan, d.access_type_sku].filter(Boolean).join(" / "), limits };
  } catch (e) {
    return { agent, limits: [], error: String(e).slice(0, 120) };
  }
}

/* ------------------------------------------------------------------- entry */
let cache: { at: number; data: AgentQuota[] } | null = null;

/** All agents' remaining quota, cached for 60s (the sources are cheap but not free). */
export async function agentQuotas(): Promise<AgentQuota[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  // claude: プールの全アカウント分 (未ログインのdirはスキップ)
  const marks = ["", "②", "③", "④"];
  const claudeDirs: string[] = [];
  for (const d of CLAUDE_DIRS) {
    try { await fs.access(path.join(d, ".credentials.json")); claudeDirs.push(d); } catch { /* not logged in */ }
  }
  if (!claudeDirs.length) claudeDirs.push(path.join(HOME, ".claude"));
  const data = await Promise.all([
    ...claudeDirs.map((d, i) => claudeQuota(d, `claude${marks[i] ?? `#${i + 1}`}`)),
    codexQuota(),
    copilotQuota(),
    Promise.resolve<AgentQuota>({
      agent: "agy",
      limits: [],
      error: "残量の取得手段が公開されていません",
    }),
  ]);
  cache = { at: Date.now(), data };
  return data;
}
