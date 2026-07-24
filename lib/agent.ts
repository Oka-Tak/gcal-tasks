import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentJobs } from "./db/schema";
import { env } from "./env";
import { type AgentName, type AgentUsage } from "./agents-catalog";
import { claudeAccounts, pickClaudeDir } from "./claude-pool";
import { agentChildEnv } from "./agent-env";

/**
 * Thin wrapper around the LOCAL CLI agents (claude / codex / copilot / agy).
 * Every invocation is logged to `agent_jobs` so the knowledge trail is durable.
 * The prompt is passed on stdin (argv for agy) and arguments are an argv array —
 * never a shell string — so user/Google content can't be interpreted by a shell.
 *
 * These run inline on the user's single, tailnet-only host. `agent_jobs` keeps the
 * audit/debug history; process separation can be reconsidered if the deployment
 * becomes internet-facing or multi-user.
 */

export type { AgentName } from "./agents-catalog";

export interface RunOptions {
  agent?: AgentName; // default "claude"
  model?: string; // per-agent model id (see lib/agents-catalog); default = each CLI's own
  effort?: string; // reasoning effort where supported (codex / agy)
  system?: string; // appended system prompt (claude only)
  allowedTools?: string[]; // claude only — allowlist (e.g. ["Read"]) to constrain
  imagePaths?: string[]; // absolute paths the agent may read (claude reads via Read)
  timeoutMs?: number;
  jobKind?: string; // for the agent_jobs ledger
  /** Live narration (claude only): intermediate text + tool calls, one line per event. */
  onEvent?: (line: string) => void;
}

export interface RunResult {
  ok: boolean;
  text: string; // the agent's final text
  error?: string;
  jobId: string;
  usage?: AgentUsage;
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  usage?: Partial<AgentUsage>; // what the runner could scrape from the CLI's output
}

function spawnCapture(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; input?: string; env?: Record<string, string> },
): Promise<Captured> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: agentChildEnv(process.env, opts.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (child.stdin) {
      if (opts.input) child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** claude -p prints a JSON envelope; text is in `.result`, usage/cost alongside. */
function parseClaudeOutput(stdout: string): { text: string; usage?: Partial<AgentUsage> } {
  try {
    const obj = JSON.parse(stdout);
    if (obj && typeof obj.result === "string") {
      const u = obj.usage ?? {};
      const cached =
        (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      return {
        text: obj.result,
        usage: {
          inputTokens: (u.input_tokens ?? 0) + cached,
          cachedTokens: cached || undefined,
          outputTokens: u.output_tokens,
          costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        },
      };
    }
  } catch {
    // not JSON (e.g. an early crash) — fall through to raw
  }
  return { text: stdout.trim() };
}

/** "12.1k" → 12100 (copilot prints approximate token counts). */
function parseKilo(s: string): number {
  const n = parseFloat(s);
  return Math.round(/k$/i.test(s) ? n * 1_000 : /m$/i.test(s) ? n * 1_000_000 : n);
}

/** One-line summary of a tool call for the live narration. */
function toolLine(name: string, input: Record<string, unknown> | undefined): string {
  const s = (v: unknown) => String(v ?? "").split("\n")[0].slice(0, 90);
  const base = (v: unknown) => s(v).split("/").pop() ?? "";
  if (name === "WebSearch") return `🔍 検索: ${s(input?.query)}`;
  if (name === "WebFetch") return `🌐 取得: ${s(input?.url)}`;
  if (name === "Read") return `📖 読込: ${base(input?.file_path)}`;
  if (name === "Bash") return `🔧 実行: ${s(input?.command)}`;
  return `🔧 ${name}`;
}

/**
 * stream-json variant of spawnCapture: forwards intermediate assistant text and
 * tool calls to `onEvent` while running, and returns a Captured whose stdout is
 * the CLI's final "result" event line — the same JSON envelope shape the plain
 * json mode prints, so parseClaudeOutput works unchanged.
 */
function spawnClaudeStream(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; input?: string; env?: Record<string, string> },
  onEvent: (line: string) => void,
): Promise<Captured> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: agentChildEnv(process.env, opts.env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    let buf = "";
    let stderr = "";
    let resultLine = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let obj: { type?: string; message?: { content?: { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[] } };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === "assistant") {
          for (const item of obj.message?.content ?? []) {
            // the final {reply,actions} envelope also arrives as assistant text
            // (bare or ```json-fenced) — keep it out of the live log
            if (item.type === "text" && item.text?.trim()
              && !item.text.trim().startsWith("{") && !item.text.trim().startsWith("```"))
              onEvent(item.text.trim());
            else if (item.type === "tool_use") onEvent(toolLine(String(item.name), item.input));
          }
        } else if (obj.type === "result") {
          resultLine = line;
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: resultLine, stderr: stderr + String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: resultLine, stderr, timedOut });
    });
    if (child.stdin) {
      if (opts.input) child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * codex `--json` JSONL variant: forwards search queries / executed commands /
 * intermediate narration to onEvent; usage comes from the turn.completed event
 * (the stderr "tokens used" footer doesn't appear in --json mode).
 */
function spawnCodexStream(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; input?: string; env?: Record<string, string> },
  onEvent: (line: string) => void,
): Promise<Captured & { eventUsage?: Partial<AgentUsage> }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: agentChildEnv(process.env, opts.env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    let buf = "";
    let stdout = "";
    let stderr = "";
    let eventUsage: Partial<AgentUsage> | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const short = (v: unknown) => String(v ?? "").split("\n")[0].slice(0, 90);
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev: {
          type?: string;
          item?: { type?: string; text?: string; query?: string; command?: string };
          usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
        };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const item = ev.item ?? {};
        if (ev.type === "item.completed" && item.type === "web_search") {
          onEvent(`🔍 検索: ${short(item.query ?? item.text)}`);
        } else if (ev.type === "item.started" && item.type === "command_execution") {
          onEvent(`🔧 実行: ${short(item.command)}`);
        } else if (ev.type === "item.completed" && item.type === "reasoning" && item.text) {
          onEvent(`💭 ${short(item.text)}`);
        } else if (ev.type === "item.completed" && item.type === "agent_message" && item.text) {
          const t = item.text.trim();
          // the final envelope also lands here — keep raw JSON out of the log
          if (!t.startsWith("{") && !t.startsWith("```")) onEvent(t);
        } else if (ev.type === "turn.completed" && ev.usage) {
          eventUsage = {
            inputTokens: ev.usage.input_tokens ?? 0,
            cachedTokens: ev.usage.cached_input_tokens || undefined,
            outputTokens: ev.usage.output_tokens,
          };
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut, eventUsage });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, eventUsage });
    });
    if (child.stdin) {
      if (opts.input) child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

async function runClaude(prompt: string, o: RunOptions, timeoutMs: number): Promise<Captured> {
  const dataAbs = path.resolve(env.dataDir);
  const stream = !!o.onEvent;
  const args = ["-p", "--output-format", stream ? "stream-json" : "json", "--permission-mode", "default"];
  if (stream) args.push("--verbose"); // stream-json requires it
  args.push("--model", o.model ?? env.claudeModel);
  if (o.effort) args.push("--effort", o.effort); // low|medium|high|xhigh|max
  if (o.allowedTools?.length) args.push("--allowedTools", ...o.allowedTools);
  if (o.system) args.push("--append-system-prompt", o.system);
  // cwd is the data dir (so uploaded images are inside the workspace and readable);
  // --add-dir (absolute) makes that explicit for the Read tool.
  args.push("--add-dir", dataAbs);
  // 複数アカウント: 5時間枠の残りが多い方の CLAUDE_CONFIG_DIR で実行
  const cfgDir = await pickClaudeDir();
  const spawnOpts = {
    cwd: dataAbs,
    timeoutMs,
    input: prompt,
    ...(cfgDir ? { env: { CLAUDE_CONFIG_DIR: cfgDir } } : {}),
  };
  return stream
    ? spawnClaudeStream(env.claudeBin, args, spawnOpts, o.onEvent as (line: string) => void)
    : spawnCapture(env.claudeBin, args, spawnOpts);
}

async function runCodex(prompt: string, o: RunOptions, timeoutMs: number): Promise<Captured> {
  // codex exec runs non-interactively (prompt on stdin). Its stdout has a banner
  // and a "tokens used" footer, so we ask it to write ONLY the final message to a
  // file and read that back.
  const dataAbs = path.resolve(env.dataDir);
  const outFile = path.join(dataAbs, `.codex-last-${crypto.randomUUID()}.txt`);
  const args = ["exec", "-", "--color", "never", "-o", outFile];
  args.push("-c", "tools.web_search=true"); // live web search (codex exec has no --search flag)
  if (o.model) args.push("-m", o.model);
  if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
  const cap = o.onEvent
    ? await spawnCodexStream(env.codexBin, [...args, "--json"], { cwd: dataAbs, timeoutMs, input: prompt }, o.onEvent)
    : await spawnCapture(env.codexBin, args, {
        cwd: dataAbs,
        timeoutMs,
        input: prompt,
      });
  let text = "";
  try {
    text = (await fs.readFile(outFile, "utf8")).trim();
  } catch {
    // fall back to raw stdout below
  }
  try {
    await fs.unlink(outFile);
  } catch {
    // best effort
  }
  // codex writes its banner/footer to stderr; the footer carries the only
  // usage figure it reports ("tokens used\n6,867"). In --json mode the
  // turn.completed event provides a richer breakdown instead.
  const tok = cap.stderr.match(/tokens used[:\s]*\n?\s*([\d,]+)/i);
  const eventUsage = (cap as Captured & { eventUsage?: Partial<AgentUsage> }).eventUsage;
  const usage = eventUsage ?? (tok ? { totalTokens: Number(tok[1].replace(/,/g, "")) } : undefined);
  return { ...cap, stdout: text || cap.stdout, usage };
}

async function runCopilot(prompt: string, o: RunOptions, timeoutMs: number): Promise<Captured> {
  // Prompt on stdin. No --allow-* flags, so tool use stays denied (the chat
  // prompt is text-only anyway). Custom instructions and the built-in GitHub
  // MCP server are skipped to keep the call hermetic. When piped, the response
  // goes to stdout and the stats footer to stderr, e.g.:
  //   Changes +0 -0 / AI Credits 0.42 (4s) / Tokens ↑ 12.1k (10.8k cached) • ↓ 31
  const dataAbs = path.resolve(env.dataDir);
  const args = ["--no-color", "--no-custom-instructions", "--disable-builtin-mcps"];
  if (o.model) args.push("--model", o.model);
  const cap = await spawnCapture(env.copilotBin, args, { cwd: dataAbs, timeoutMs, input: prompt });

  const usage: Partial<AgentUsage> = {};
  const credits = cap.stderr.match(/AI Credits\s+([\d.]+)/);
  if (credits) usage.credits = Number(credits[1]);
  const tok = cap.stderr.match(
    /Tokens\s+↑\s*([\d.]+[km]?)(?:\s*\(([\d.]+[km]?) cached\))?\s*•\s*↓\s*([\d.]+[km]?)/i,
  );
  if (tok) {
    usage.inputTokens = parseKilo(tok[1]);
    if (tok[2]) usage.cachedTokens = parseKilo(tok[2]);
    usage.outputTokens = parseKilo(tok[3]);
  }
  return { ...cap, usage };
}

async function runAgy(prompt: string, o: RunOptions, timeoutMs: number): Promise<Captured> {
  // agy --print <prompt> runs non-interactively and prints only the response —
  // the prompt is the flag's VALUE, not a positional. The model is antigravity's
  // display string with effort baked in ("Gemini 3.5 Flash (High)").
  //
  // agy は独自の権限システムを持ち、ヘッドレス(--print)では許可プロンプトを出せず
  // ファイル検索やシェル実行を自動拒否する（「フォルダからバスのURLを探して」等が
  // 何もできず終わる）。--dangerously-skip-permissions で自動承認する。
  // ＝ Kairosの4エージェントのうち agy を「実際に手を動かせる担当」に位置づける。
  // 他(claude=WebSearch/WebFetchのみ, copilot=ツール拒否, codex=サンドボックス)は
  // 従来どおり制限。※agyはRAG/フォルダ内容も読むので、投げる依頼には注意。
  const dataAbs = path.resolve(env.dataDir);
  const args = ["--dangerously-skip-permissions", "--print", prompt];
  if (o.model) args.push("--model", o.effort ? `${o.model} (${o.effort})` : o.model);
  return spawnCapture(env.agyBin, args, { cwd: dataAbs, timeoutMs });
}

/** Run a local agent, recording the call in agent_jobs. */
export async function runAgent(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const agent: AgentName = opts.agent ?? "claude";
  const timeoutMs = opts.timeoutMs ?? env.agentTimeoutMs;
  const jobId = crypto.randomUUID();
  const startedAt = Date.now();

  // The agents run with cwd = data dir; ensure it exists (chat may run before any upload).
  await fs.mkdir(path.resolve(env.dataDir), { recursive: true });

  db.insert(agentJobs)
    .values({
      id: jobId,
      kind: opts.jobKind ?? "chat",
      agent,
      status: "running",
      payload: JSON.stringify({
        prompt,
        model: opts.model ?? (agent === "claude" ? env.claudeModel : undefined),
        effort: opts.effort,
        imagePaths: opts.imagePaths ?? [],
      }),
      createdAt: startedAt,
      startedAt,
    })
    .run();

  let cap: Captured;
  if (agent === "codex") cap = await runCodex(prompt, opts, timeoutMs);
  else if (agent === "copilot") cap = await runCopilot(prompt, opts, timeoutMs);
  else if (agent === "agy") cap = await runAgy(prompt, opts, timeoutMs);
  else cap = await runClaude(prompt, opts, timeoutMs);

  let text: string;
  let scraped: Partial<AgentUsage> | undefined = cap.usage;
  if (agent === "claude") {
    const parsed = parseClaudeOutput(cap.stdout);
    text = parsed.text;
    scraped = parsed.usage;
  } else {
    text = cap.stdout.trim();
  }
  const usage: AgentUsage = {
    ...scraped,
    model: opts.model ?? (agent === "claude" ? env.claudeModel : undefined),
    effort: opts.effort,
    durationMs: Date.now() - startedAt,
  };
  const ok = cap.code === 0 && !cap.timedOut && text.length > 0;
  const error = ok
    ? undefined
    : cap.timedOut
      ? `timed out after ${timeoutMs}ms`
      : (cap.stderr || `exit ${cap.code}`).slice(0, 2000);

  db.update(agentJobs)
    .set({
      status: ok ? "done" : "error",
      result: ok ? text.slice(0, 100_000) : null,
      error: error ?? null,
      usage: JSON.stringify(usage),
      finishedAt: Date.now(),
    })
    .where(eq(agentJobs.id, jobId))
    .run();

  return { ok, text, error, jobId, usage };
}

/** フォールバック連鎖の1段: このエージェント・モデルで試す。 */
export interface AgentStep {
  agent: AgentName;
  model?: string;
  effort?: string;
}

/** バックグラウンドジョブ用の既定連鎖: claude枠が薄い時は codex → copilot → agy。 */
export const BG_FALLBACK: AgentStep[] = [
  { agent: "claude" }, // model は opts.model を引き継ぐ
  { agent: "codex", model: "gpt-5.4-mini", effort: "medium" },
  { agent: "copilot", model: "auto" },
  { agent: "agy", model: "Gemini 3.5 Flash", effort: "Medium" },
];

/**
 * 生存確認プローブ: 各エージェントの最安モデルに「1+1」を投げて動くか見る。
 * limit到達・CLI故障・認証切れを数秒で検知して次の段へ渡すため。
 * 結果はキャッシュ（成功10分・失敗3分）。実呼び出しの成否でも上書きするので、
 * 定常時のプローブ頻度はごく低い。
 */
const PROBE_MODELS: Record<AgentName, { model?: string; effort?: string }> = {
  claude: { model: "haiku", effort: "low" },
  codex: { model: "gpt-5.4-mini", effort: "low" },
  copilot: { model: "auto" },
  agy: { model: "Gemini 3.5 Flash", effort: "Low" },
};
const PROBE_OK_MS = 10 * 60_000;
const PROBE_FAIL_MS = 3 * 60_000;
const gp = globalThis as unknown as { __agentProbe?: Map<AgentName, { ok: boolean; at: number }> };
const probeCache = () => (gp.__agentProbe ??= new Map());

export function noteAgentResult(agent: AgentName, ok: boolean): void {
  probeCache().set(agent, { ok, at: Date.now() });
}

export async function probeAgent(agent: AgentName): Promise<boolean> {
  const c = probeCache().get(agent);
  if (c && Date.now() - c.at < (c.ok ? PROBE_OK_MS : PROBE_FAIL_MS)) return c.ok;
  const res = await runAgent("1+1の答えを数字だけで出力して。", {
    agent,
    ...PROBE_MODELS[agent],
    timeoutMs: 90_000,
    jobKind: "probe",
  });
  noteAgentResult(agent, res.ok);
  if (!res.ok) console.log(`[agent-probe] ${agent} 不調: ${(res.error ?? "").slice(0, 100)}`);
  return res.ok;
}

/** claude の5時間枠残り%（プール内の最良アカウント）。取得失敗は null。 */
async function bestClaudeRemaining(): Promise<number | null> {
  try {
    const accounts = await claudeAccounts();
    const vals = accounts.map((a) => a.remaining).filter((v): v is number => v != null);
    return vals.length > 0 ? Math.max(...vals) : null;
  } catch {
    return null;
  }
}

/**
 * usage を意識したエージェント実行: claude の残り枠が薄い(既定<15%)時や失敗時に
 * codex / copilot / agy へ順に切り替える。ノート要約などのバックグラウンド
 * ジョブ用 — 対話チャットはユーザーのモデル選択を尊重するので使わない。
 */
export async function runAgentAuto(
  prompt: string,
  opts: RunOptions = {},
  chain?: AgentStep[],
  minClaudePct = Number(process.env.KAIROS_CLAUDE_MIN_PCT ?? 15),
): Promise<RunResult> {
  // 優先順位は data/agent-priority.json（UI/APIで並び替え可）。明示chainはそれを上書き。
  const { loadPriority } = await import("./agent-priority");
  const cfg = loadPriority();
  const steps = chain ?? cfg.order;
  const probeOn = chain ? false : cfg.probe; // 明示chain（グラス用高速連鎖等）はプローブ無し
  let last: RunResult | null = null;
  for (const step of steps) {
    if (step.agent === "claude") {
      const rem = await bestClaudeRemaining();
      if (rem != null && rem < minClaudePct) {
        console.log(`[agent-auto] claude残り${rem}% (<${minClaudePct}%) — ${opts.jobKind ?? "job"} を次のエージェントへ`);
        continue;
      }
    }
    // 生存確認: 最安モデルの素振りが通らないエージェントは飛ばす（結果はキャッシュ）
    if (probeOn && !(await probeAgent(step.agent))) {
      console.log(`[agent-auto] ${step.agent} プローブ不通 — ${opts.jobKind ?? "job"} を次へ`);
      continue;
    }
    const res = await runAgent(prompt, {
      ...opts,
      agent: step.agent,
      model: step.agent === "claude" ? (opts.model ?? step.model) : (step.model ?? opts.model),
      effort: step.agent === "claude" ? (opts.effort ?? step.effort) : (step.effort ?? opts.effort),
      // claude 専用オプションは他エージェントに渡さない
      ...(step.agent !== "claude" ? { system: undefined, allowedTools: undefined, onEvent: undefined } : {}),
    });
    noteAgentResult(step.agent, res.ok); // 実結果でプローブキャッシュを更新
    if (res.ok) {
      if (step.agent !== "claude") console.log(`[agent-auto] ${opts.jobKind ?? "job"} → ${step.agent} で完了`);
      return res;
    }
    last = res;
    console.log(`[agent-auto] ${step.agent} 失敗 (${(res.error ?? "").slice(0, 120)}) — 次へ`);
  }
  return last ?? { ok: false, text: "", error: "全エージェントが失敗/枠切れ", jobId: "" };
}

/** Pull the first JSON object/array out of an agent's text (it may add prose/fences). */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // try to slice from the first brace/bracket to its match
      const start = trimmed.search(/[{[]/);
      if (start === -1) continue;
      const open = trimmed[start];
      const close = open === "{" ? "}" : "]";
      const end = trimmed.lastIndexOf(close);
      if (end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1)) as T;
        } catch {
          // give up on this candidate
        }
      }
    }
  }
  return null;
}
