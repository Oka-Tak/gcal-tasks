import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * AIエクスポートの自動取り込み: OneDrive の「AIエクスポート」フォルダに
 * Claude / ChatGPT のエクスポートzipを置く（Windows側からSyncthing経由でOK）と、
 * 30分タイマーがこれを検出して展開し、種類を判定して既存のインポータを回す:
 *   - Claude:  import-claude-web.ts（RAG化）+ import-claude-web-chats.ts（OWUIスレッド化）
 *   - ChatGPT: import-chatgpt.ts（RAG化）
 * インポータ自体が冪等なので、同じzipの再検出・再エクスポートの上書きも安全。
 * state: ~/.local/state/ai-export-watch.json（zip名 → mtime/size/結果）。
 */

const exec = promisify(execFile);
const DROP =
  process.env.KAIROS_AI_EXPORT_DIR ??
  path.join(os.homedir(), "onedrive-sync", "zdk7v-hfcmy", "AIエクスポート");
const STATE = path.join(os.homedir(), ".local", "state", "ai-export-watch.json");
const REPO = path.join(os.homedir(), "gcal-tasks");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const SETTLE_MS = 2 * 60_000; // Syncthing転送中のzipを掴まない

interface Entry { mtimeMs: number; size: number; kind: string; at: number }
type State = Record<string, Entry>;

async function loadState(): Promise<State> {
  try { return JSON.parse(await fs.readFile(STATE, "utf8")); } catch { return {}; }
}
async function saveState(s: State) {
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(s, null, 1));
}

/** .env.local から ntfy 設定だけ拾って完了通知（未設定なら黙る）。 */
async function notify(title: string, message: string): Promise<void> {
  try {
    const envf = await fs.readFile(path.join(REPO, ".env.local"), "utf8");
    const pick = (k: string) => new RegExp(`${k}=["']?([^"'\n]+)`).exec(envf)?.[1];
    const url = pick("KAIROS_NTFY_URL");
    const topic = pick("KAIROS_NTFY_TOPIC");
    if (!url || !topic) return;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message, tags: ["inbox_tray"] }),
    });
  } catch { /* 通知は失われても取り込みは成功している */ }
}

async function findFile(root: string, name: string): Promise<string | null> {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  return null;
}

async function runImporter(script: string, arg: string): Promise<void> {
  console.log(`[ai-export] run: ${path.basename(script)} ${arg}`);
  const { stdout, stderr } = await exec(process.execPath, [TSX, script, arg], {
    cwd: REPO,
    maxBuffer: 16_000_000,
    timeout: 60 * 60_000,
  });
  if (stdout.trim()) console.log(stdout.trim().split("\n").slice(-5).join("\n"));
  if (stderr.trim()) console.log(stderr.trim().split("\n").slice(-3).join("\n"));
}

async function main() {
  await fs.mkdir(DROP, { recursive: true }); // フォルダを作っておく = Windows側にも同期されて置き場が見える
  const state = await loadState();
  let zips: string[] = [];
  try {
    zips = (await fs.readdir(DROP)).filter((n) => n.toLowerCase().endsWith(".zip") && !n.startsWith("."));
  } catch { return; }

  for (const name of zips) {
    const abs = path.join(DROP, name);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) continue;
    if (Date.now() - st.mtimeMs < SETTLE_MS) { console.log(`[ai-export] settling: ${name}`); continue; }
    const prev = state[name];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-export-"));
    try {
      await exec("unzip", ["-o", "-q", abs, "-d", tmp], { maxBuffer: 8_000_000 });
      const conv = await findFile(tmp, "conversations.json");
      if (!conv) {
        console.log(`[ai-export] conversations.json が見つからない: ${name}`);
        state[name] = { mtimeMs: st.mtimeMs, size: st.size, kind: "unknown", at: Date.now() };
        continue;
      }
      const dir = path.dirname(conv);
      const head = (await fs.readFile(conv, "utf8")).slice(0, 6000);
      const kind = head.includes('"mapping"') ? "chatgpt" : head.includes('"chat_messages"') ? "claude" : "unknown";
      console.log(`[ai-export] ${name} → ${kind}`);
      if (kind === "chatgpt") {
        await runImporter(path.join(REPO, "scripts", "import-chatgpt.ts"), dir);
      } else if (kind === "claude") {
        await runImporter(path.join(REPO, "scripts", "import-claude-web.ts"), dir);
        await runImporter(path.join(REPO, "scripts", "import-claude-web-chats.ts"), dir);
      } else {
        console.log(`[ai-export] 形式を判定できない: ${name}`);
      }
      state[name] = { mtimeMs: st.mtimeMs, size: st.size, kind, at: Date.now() };
      await saveState(state);
      if (kind !== "unknown") {
        await notify(`📥 ${kind === "claude" ? "Claude" : "ChatGPT"} エクスポート取り込み完了`, `${name} をRAGに反映しました`);
      }
    } catch (e) {
      console.log(`[ai-export] failed (${name}): ${String(e).slice(0, 200)}`);
      // stateに記録しない = 次回リトライ
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  await saveState(state);
}

void main().catch((e) => {
  console.error("[ai-export] failed:", e);
  process.exitCode = 1;
});
