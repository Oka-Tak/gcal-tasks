import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentJobs } from "./db/schema";
import { env } from "./env";

/**
 * Thin wrapper around the LOCAL CLI agents (claude / codex). Every invocation is
 * logged to `agent_jobs` so the knowledge trail is durable. The prompt is passed
 * on stdin and arguments are an argv array — never a shell string — so user/Google
 * content can't be interpreted by a shell.
 *
 * Today these run inline in the request. Before publishing (Cloudflare), move the
 * actual spawn into a separate local worker that drains `agent_jobs`; the table is
 * the seam for that. See CONTEXT.md.
 */

export type AgentName = "claude" | "codex";

export interface RunOptions {
  agent?: AgentName; // default "claude"
  model?: string; // alias (claude only); default env.claudeModel
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
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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

/** claude -p prints a JSON envelope; the model's text is in `.result`. */
function parseClaudeOutput(stdout: string): string {
  try {
    const obj = JSON.parse(stdout);
    if (obj && typeof obj.result === "string") return obj.result;
  } catch {
    // not JSON (e.g. an early crash) — fall through to raw
  }
  return stdout.trim();
}

async function runClaude(prompt: string, o: RunOptions, timeoutMs: number): Promise<Captured> {
  const dataAbs = path.resolve(env.dataDir);
  const args = ["-p", "--output-format", "json", "--permission-mode", "default"];
  args.push("--model", o.model ?? env.claudeModel);
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

async function runCodex(prompt: string, _o: RunOptions, timeoutMs: number): Promise<Captured> {
  // codex exec runs non-interactively (prompt on stdin). Its stdout has a banner
  // and a "tokens used" footer, so we ask it to write ONLY the final message to a
  // file and read that back.
  const dataAbs = path.resolve(env.dataDir);
  const outFile = path.join(dataAbs, `.codex-last-${crypto.randomUUID()}.txt`);
  const cap = await spawnCapture(
    env.codexBin,
    ["exec", "-", "--color", "never", "-o", outFile],
    { cwd: dataAbs, timeoutMs, input: prompt },
  );
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
  return { ...cap, stdout: text || cap.stdout };
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
        imagePaths: opts.imagePaths ?? [],
      }),
      createdAt: startedAt,
      startedAt,
    })
    .run();

  let cap: Captured;
  if (agent === "codex") cap = await runCodex(prompt, opts, timeoutMs);
  else cap = await runClaude(prompt, opts, timeoutMs);

  const text =
    agent === "claude" ? parseClaudeOutput(cap.stdout) : cap.stdout.trim();
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
      finishedAt: Date.now(),
    })
    .where(eq(agentJobs.id, jobId))
    .run();

  return { ok, text, error, jobId };
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
