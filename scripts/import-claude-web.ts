import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pushLocalFileToOwui, removeOwuiFile } from "../lib/owui";

/**
 * Import a Claude.ai data export (conversations.json + projects/*.json) into
 * Open WebUI Knowledge so past web chats become cross-searchable from the :443
 * chat / mnemo / glasses — and readable locally by Claude Code.
 *
 *   tsx scripts/import-claude-web.ts <extracted-export-dir>
 *
 * Each conversation → one markdown file in ~/claude-web-export/conversations/,
 * indexed into the「Claude Web履歴」collection. Each project's docs → markdown
 * under ~/claude-web-export/projects/<name>/, indexed into「Claude PJ: <name>」
 * (kept separate so course materials don't bleed into each other in RAG).
 *
 * Snapshot-based: re-export from Claude.ai and re-run — the state file keeps it
 * idempotent, only (re)pushing new or updated items.
 */

const OUT = path.join(os.homedir(), "claude-web-export");
const STATE = path.join(os.homedir(), ".local", "state", "claude-web-import.json");
const CONV_COLLECTION = "Claude Web履歴";
const THROTTLE_MS = Number(process.env.KAIROS_SYNC_THROTTLE_MS ?? 800);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry { updatedAt: string; fileId: string; collection: string }
type State = Record<string, Entry>;

async function loadState(): Promise<State> {
  try { return JSON.parse(await fs.readFile(STATE, "utf8")); } catch { return {}; }
}
async function saveState(s: State) {
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(s, null, 1));
}

const safe = (s: string | null | undefined) =>
  (s || "無題")
    .replace(/[\/\\\n\r\t]+/g, " ")
    .replace(/[^\p{L}\p{N} ._　\-]/gu, "")
    .trim()
    .slice(0, 60) || "無題";

interface Msg {
  sender?: string; text?: string; created_at?: string;
  content?: { type?: string; text?: string }[];
  attachments?: { file_name?: string }[];
  files?: { file_name?: string }[];
}

function messageText(m: Msg): string {
  const parts = Array.isArray(m.content) ? m.content : [];
  const texts = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string);
  let body = texts.join("\n").trim();
  if (!body && typeof m.text === "string") body = m.text.trim();
  const atts = [...(m.attachments ?? []), ...(m.files ?? [])]
    .map((a) => a?.file_name)
    .filter(Boolean);
  if (atts.length) body += `\n\n> 📎 添付: ${atts.join(", ")}`;
  return body;
}

function conversationMd(c: {
  name?: string; summary?: string; uuid: string;
  created_at?: string; updated_at?: string; chat_messages?: Msg[];
}): string {
  const lines: string[] = [
    `# ${c.name || "無題の会話"}`,
    "",
    `- 期間: ${c.created_at ?? "?"} 〜 ${c.updated_at ?? "?"}`,
    `- ソース: Claude.ai 会話 (${c.uuid})`,
  ];
  if (c.summary) lines.push("", `> ${c.summary}`);
  lines.push("", "---");
  for (const m of c.chat_messages ?? []) {
    const who = m.sender === "human" ? "👤 自分" : m.sender === "assistant" ? "🤖 Claude" : (m.sender ?? "?");
    const body = messageText(m);
    if (!body) continue;
    lines.push("", `## ${who}`, "", body);
  }
  return lines.join("\n");
}

async function push(
  state: State, key: string, updatedAt: string, collection: string,
  filename: string, content: string, localPath: string,
  counters: { pushed: number; skipped: number; failed: number },
): Promise<void> {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, content);
  const prev = state[key];
  if (prev && prev.updatedAt === updatedAt && prev.fileId) { counters.skipped++; return; }
  if (prev?.fileId) await removeOwuiFile(prev.collection, prev.fileId).catch(() => {});
  try {
    const fileId = await pushLocalFileToOwui(Buffer.from(content, "utf8"), filename, collection);
    state[key] = { updatedAt, fileId, collection };
    counters.pushed++;
    console.log(`[claude-web] pushed ${filename} → "${collection}"`);
    await saveState(state);
  } catch (e) {
    counters.failed++;
    console.log(`[claude-web] retry-later ${filename}: ${String(e).slice(0, 120)}`);
  }
  await sleep(THROTTLE_MS);
}

async function main() {
  const src = process.argv[2];
  if (!src) { console.error("usage: import-claude-web.ts <extracted-export-dir>"); process.exit(1); }
  const state = await loadState();
  const counters = { pushed: 0, skipped: 0, failed: 0 };

  // --- conversations ---
  const convs = JSON.parse(await fs.readFile(path.join(src, "conversations.json"), "utf8")) as Parameters<typeof conversationMd>[0][];
  console.log(`[claude-web] ${convs.length} conversations`);
  for (const c of convs) {
    const md = conversationMd(c);
    const fn = `${safe(c.name)}__${c.uuid.slice(0, 8)}.md`;
    await push(
      state, `conv:${c.uuid}`, c.updated_at ?? "", CONV_COLLECTION,
      fn, md, path.join(OUT, "conversations", fn), counters,
    );
  }

  // --- project docs ---
  let projFiles: string[] = [];
  try {
    projFiles = (await fs.readdir(path.join(src, "projects"))).filter((f) => f.endsWith(".json"));
  } catch { /* no projects dir */ }
  for (const pf of projFiles) {
    const p = JSON.parse(await fs.readFile(path.join(src, "projects", pf), "utf8")) as {
      name?: string; description?: string; uuid: string; updated_at?: string;
      docs?: { uuid: string; filename?: string; content?: string; created_at?: string }[];
    };
    const collection = `Claude PJ: ${safe(p.name)}`;
    const dir = path.join(OUT, "projects", safe(p.name));
    for (const d of p.docs ?? []) {
      if (!d.content?.trim()) continue;
      const base = safe(d.filename?.replace(/\.[^.]*$/, "") ?? d.uuid.slice(0, 8));
      const fn = `${base}.md`;
      const md = `# ${d.filename ?? base}\n\n- プロジェクト: ${p.name ?? "?"}\n- ソース: Claude.ai プロジェクト資料\n\n---\n\n${d.content}`;
      await push(
        state, `doc:${d.uuid}`, d.created_at ?? p.updated_at ?? "", collection,
        fn, md, path.join(dir, fn), counters,
      );
    }
  }

  await saveState(state);
  console.log(`[claude-web] done: +${counters.pushed} (skipped ${counters.skipped}, retry-later ${counters.failed})`);
  console.log(`[claude-web] local copies under ${OUT}`);
}

void main().catch((e) => { console.error("[claude-web] failed:", e); process.exitCode = 1; });
