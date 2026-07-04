import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentJobs } from "./db/schema";
import { env } from "./env";
import { type AgentName, type AgentUsage } from "./agents-catalog";

/**
 * Thin wrapper around the LOCAL CLI agents (claude / codex / copilot / agy).
 * Every invocation is logged to `agent_jobs` so the knowledge trail is durable.
 * The prompt is passed on stdin (argv for agy) and arguments are an argv array —
 * never a shell string — so user/Google content can't be interpreted by a shell.
 *
 * Today these run inline in the request. Before publishing (Cloudflare), move the
 * actual spawn into a separate local worker that drains `agent_jobs`; the table is
 * the seam for that. See CONTEXT.md.
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
  opts: { cwd?: string; timeoutMs: number; input?: string },
): Promise<Captured> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: process.env,
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

async function runClaude(prompt: string, o: RunOptions, timeoutMs: number): Promise<Captured> {
  const dataAbs = path.resolve(env.dataDir);
  const args = ["-p", "--output-format", "json", "--permission-mode", "default"];
  args.push("--model", o.model ?? env.claudeModel);
  if (o.effort) args.push("--effort", o.effort); // low|medium|high|xhigh|max
  if (o.allowedTools?.length) args.push("--allowedTools", ...o.allowedTools);
  if (o.system) args.push("--append-system-prompt", o.system);
  // cwd is the data dir (so uploaded images are inside the workspace and readable);
  // --add-dir (absolute) makes that explicit for the Read tool.
  args.push("--add-dir", dataAbs);
  return spawnCapture(env.claudeBin, args, {
    cwd: dataAbs,
    timeoutMs,
    input: prompt,
  });
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
  const cap = await spawnCapture(env.codexBin, args, {
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
  // usage figure it reports ("tokens used\n6,867").
  const tok = cap.stderr.match(/tokens used[:\s]*\n?\s*([\d,]+)/i);
  const usage = tok ? { totalTokens: Number(tok[1].replace(/,/g, "")) } : undefined;
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
  const dataAbs = path.resolve(env.dataDir);
  const args = ["--print", prompt];
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
