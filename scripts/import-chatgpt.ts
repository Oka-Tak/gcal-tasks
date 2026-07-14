import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pushLocalFileToOwui, removeOwuiFile } from "../lib/owui";

/**
 * ChatGPT のデータエクスポート（conversations.json）を Open WebUI Knowledge
 * 「ChatGPT履歴」へ取り込む。Claude 版（import-claude-web.ts）の ChatGPT 流儀:
 *
 *   tsx scripts/import-chatgpt.ts <extracted-export-dir>
 *
 * 会話ごとに ~/chatgpt-export/conversations/*.md を書き（Claude Code からも
 * grep 可能）、更新された会話だけ OWUI に再push する（state で冪等）。
 * mapping はツリー構造なので current_node から親を遡って本流だけを線形化する。
 */

const OUT = path.join(os.homedir(), "chatgpt-export");
const STATE = path.join(os.homedir(), ".local", "state", "chatgpt-import.json");
const COLLECTION = "ChatGPT履歴";
const THROTTLE_MS = Number(process.env.KAIROS_SYNC_THROTTLE_MS ?? 800);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry { updatedAt: number; fileId: string }
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
    .replace(/[/\\\n\r\t]+/g, " ")
    .replace(/[^\p{L}\p{N} ._　\-]/gu, "")
    .trim()
    .slice(0, 60) || "無題";

interface CgptNode {
  id?: string;
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[]; text?: string };
  } | null;
  parent?: string | null;
  children?: string[];
}
interface CgptConvo {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  mapping?: Record<string, CgptNode>;
}

function textOf(n: CgptNode): string {
  const c = n.message?.content;
  if (!c) return "";
  if (typeof c.text === "string") return c.text;
  return (c.parts ?? [])
    .map((p) => (typeof p === "string" ? p : typeof p === "object" && p && "text" in p ? String((p as { text?: string }).text ?? "") : ""))
    .join("\n")
    .trim();
}

/** current_node から親へ遡って本流を線形化（分岐の脇道は捨てる）。 */
function linearize(c: CgptConvo): { role: string; text: string }[] {
  const map = c.mapping ?? {};
  const chain: CgptNode[] = [];
  let cur: string | null | undefined = c.current_node;
  // current_node 不明時は葉ノードを探す
  if (!cur || !map[cur]) cur = Object.keys(map).find((k) => (map[k].children ?? []).length === 0);
  const seen = new Set<string>();
  while (cur && map[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(map[cur]);
    cur = map[cur].parent;
  }
  chain.reverse();
  return chain
    .map((n) => ({ role: n.message?.author?.role ?? "", text: textOf(n) }))
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim().length > 0);
}

function convoMd(c: CgptConvo, msgs: { role: string; text: string }[]): string {
  const dt = c.create_time ? new Date(c.create_time * 1000) : null;
  return [
    `# ${c.title ?? "無題"}`,
    dt ? `- 日時: ${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}` : "",
    "- 出典: ChatGPT",
    "",
    ...msgs.map((m) => `## ${m.role === "user" ? "👤 ユーザー" : "🤖 ChatGPT"}\n\n${m.text.trim()}\n`),
  ].filter(Boolean).join("\n");
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: tsx scripts/import-chatgpt.ts <extracted-export-dir>");
    process.exitCode = 1;
    return;
  }
  const convPath = path.join(dir, "conversations.json");
  const convos = JSON.parse(await fs.readFile(convPath, "utf8")) as CgptConvo[];
  const state = await loadState();
  await fs.mkdir(path.join(OUT, "conversations"), { recursive: true });

  let pushed = 0, skipped = 0, failed = 0;
  for (const c of convos) {
    const id = c.conversation_id ?? c.id ?? "";
    if (!id) continue;
    const updatedAt = Math.round((c.update_time ?? c.create_time ?? 0) * 1000);
    const prev = state[id];
    if (prev && prev.updatedAt === updatedAt) { skipped++; continue; }
    const msgs = linearize(c);
    if (msgs.length === 0) { skipped++; continue; }
    const md = convoMd(c, msgs);
    const fname = `${safe(c.title)}_${id.slice(0, 8)}.md`;
    await fs.writeFile(path.join(OUT, "conversations", fname), md);
    try {
      if (prev?.fileId) await removeOwuiFile(COLLECTION, prev.fileId).catch(() => {});
      const buf = Buffer.from(md.slice(0, 200_000), "utf8"); // 巨大会話はOWUI保護のためカット
      const fileId = await pushLocalFileToOwui(buf, fname, COLLECTION);
      state[id] = { updatedAt, fileId };
      await saveState(state);
      pushed++;
      console.log(`[chatgpt] pushed ${fname}`);
    } catch (e) {
      failed++;
      console.log(`[chatgpt] push failed (${fname}): ${String(e).slice(0, 120)}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`[chatgpt] done: +${pushed} (skip ${skipped}, fail ${failed}) of ${convos.length}`);
}

void main().catch((e) => {
  console.error("[chatgpt] failed:", e);
  process.exitCode = 1;
});
