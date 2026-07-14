import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Import a Claude.ai export's conversations as BROWSABLE Open WebUI chat threads
 * (sidebar), grouped under a "Claude Web履歴" folder. Companion to
 * import-claude-web.ts (which loads the same conversations as RAG knowledge):
 * this one is for reading/scrolling old chats like on claude.ai.
 *
 *   tsx scripts/import-claude-web-chats.ts <extracted-export-dir>
 *
 * Idempotent via ~/.local/state/claude-web-chats.json (conv uuid → owui chat id);
 * re-running after a fresh export only creates threads for new conversations.
 */

const OWUI = process.env.KAIROS_OWUI_URL ?? "http://127.0.0.1:3300";
const STATE = path.join(os.homedir(), ".local", "state", "claude-web-chats.json");
const FOLDER = "Claude Web履歴";

type State = Record<string, string>;
const load = async (): Promise<State> => { try { return JSON.parse(await fs.readFile(STATE, "utf8")); } catch { return {}; } };
const save = async (s: State) => { await fs.mkdir(path.dirname(STATE), { recursive: true }); await fs.writeFile(STATE, JSON.stringify(s, null, 1)); };

let token = "";
async function api(method: string, p: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${OWUI}${p}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

async function getFolderId(): Promise<string | null> {
  try {
    const folders = (await api("GET", "/api/v1/folders/")) as { id: string; name: string }[];
    const hit = folders.find((f) => f.name === FOLDER);
    if (hit) return hit.id;
    const created = (await api("POST", "/api/v1/folders/", { name: FOLDER })) as { id: string };
    return created.id;
  } catch (e) { console.log(`[chats] folder err: ${String(e).slice(0, 120)}`); return null; }
}

interface Msg {
  sender?: string; text?: string; created_at?: string;
  content?: { type?: string; text?: string }[];
  attachments?: { file_name?: string }[]; files?: { file_name?: string }[];
}

function msgText(m: Msg): string {
  const parts = Array.isArray(m.content) ? m.content : [];
  let body = parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("\n").trim();
  if (!body && typeof m.text === "string") body = m.text.trim();
  const atts = [...(m.attachments ?? []), ...(m.files ?? [])].map((a) => a?.file_name).filter(Boolean);
  if (atts.length) body += `\n\n> 📎 添付: ${atts.join(", ")}`;
  return body;
}

const epoch = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000); };

function buildChat(c: { name?: string; uuid: string; timestamp?: string; chat_messages?: Msg[] }) {
  const usable = (c.chat_messages ?? []).map((m) => ({ role: m.sender === "human" ? "user" : "assistant", content: msgText(m), ts: epoch(m.created_at) })).filter((m) => m.content);
  const nodes = usable.map((m) => ({ id: randomUUID(), parentId: null as string | null, childrenIds: [] as string[], role: m.role, content: m.content, timestamp: m.ts, models: ["claude.ai"], model: "claude.ai" }));
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].parentId = i > 0 ? nodes[i - 1].id : null;
    nodes[i].childrenIds = i < nodes.length - 1 ? [nodes[i + 1].id] : [];
  }
  const messages: Record<string, typeof nodes[number]> = {};
  for (const n of nodes) messages[n.id] = n;
  const currentId = nodes.length ? nodes[nodes.length - 1].id : null;
  return {
    id: "", title: c.name || "無題の会話", models: ["claude.ai"],
    history: { messages, currentId }, messages: nodes, files: [], tags: [],
    timestamp: nodes.length ? nodes[0].timestamp * 1000 : Date.now(),
  };
}

async function main() {
  const src = process.argv[2];
  if (!src) { console.error("usage: import-claude-web-chats.ts <extracted-export-dir>"); process.exit(1); }
  token = ((await api("POST", "/api/v1/auths/signin", { email: "", password: "" })) as { token: string }).token;
  const state = await load();
  const folderId = await getFolderId();
  const convs = JSON.parse(await fs.readFile(path.join(src, "conversations.json"), "utf8")) as Parameters<typeof buildChat>[0][];
  console.log(`[chats] ${convs.length} conversations, folder=${folderId}`);
  let made = 0, skipped = 0, empty = 0;
  for (const c of convs) {
    if (state[c.uuid]) { skipped++; continue; }
    const chat = buildChat(c);
    if (!chat.messages.length) { empty++; continue; }
    try {
      const r = (await api("POST", "/api/v1/chats/new", { chat })) as { id: string };
      if (folderId) await api("POST", `/api/v1/chats/${r.id}/folder`, { folder_id: folderId }).catch(() => {});
      state[c.uuid] = r.id; made++;
      if (made % 20 === 0) { await save(state); console.log(`[chats] ${made} created…`); }
    } catch (e) { console.log(`[chats] fail ${c.uuid.slice(0, 8)}: ${String(e).slice(0, 120)}`); }
  }
  await save(state);
  console.log(`[chats] done: +${made} (skipped ${skipped}, empty ${empty}) → フォルダ「${FOLDER}」`);
}

void main().catch((e) => { console.error("[chats] failed:", e); process.exitCode = 1; });
