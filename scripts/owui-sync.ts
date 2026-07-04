import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { owuiSupportedExt, pushLocalFileToOwui, removeOwuiFile } from "../lib/owui";

/**
 * Sync ~/onedrive-sync (Syncthing mirror of the user's OneDrive folders) into
 * Open WebUI Knowledge. Packing rule: each top-level directory is one
 * collection — "OneDrive: <dir>" — so per-course folders stay separate in RAG.
 *
 * State (relpath → {mtimeMs,size,fileId,collection}) lives in
 * ~/.local/state/owui-sync.json; changed files replace their old upload,
 * deleted files are detached. Run via owui-sync.timer (or by hand with tsx).
 */

const ROOT = process.env.KAIROS_SYNC_ROOT ?? path.join(os.homedir(), "onedrive-sync");
const STATE = path.join(os.homedir(), ".local", "state", "owui-sync.json");
const MAX_BYTES = 50_000_000;

interface Entry { mtimeMs: number; size: number; fileId: string; collection: string }

async function loadState(): Promise<Record<string, Entry>> {
  try {
    return JSON.parse(await fs.readFile(STATE, "utf8"));
  } catch {
    return {};
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".st") || e.name.startsWith(".")) continue; // .stfolder / temp / hidden
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function main() {
  const state = await loadState();
  const seen = new Set<string>();
  let pushed = 0, removed = 0, skipped = 0;

  let tops: string[] = [];
  try {
    tops = (await fs.readdir(ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    console.log(`[owui-sync] sync root not ready: ${ROOT}`);
    return;
  }

  for (const top of tops) {
    const collection = `OneDrive: ${top}`;
    for await (const abs of walk(path.join(ROOT, top))) {
      const rel = path.relative(ROOT, abs);
      seen.add(rel);
      const ext = path.extname(abs);
      if (!owuiSupportedExt(ext)) { skipped++; continue; }
      const st = await fs.stat(abs);
      if (st.size === 0 || st.size > MAX_BYTES) { skipped++; continue; }
      const prev = state[rel];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue; // unchanged

      if (prev) await removeOwuiFile(prev.collection, prev.fileId).catch(() => {});
      // flatten the relative path into the filename so RAG citations stay readable
      const filename = rel.split(path.sep).slice(1).join("__") || path.basename(abs);
      const fileId = await pushLocalFileToOwui(await fs.readFile(abs), filename, collection);
      state[rel] = { mtimeMs: st.mtimeMs, size: st.size, fileId, collection };
      pushed++;
      console.log(`[owui-sync] pushed ${rel} → "${collection}"`);
    }
  }

  // files that vanished from the mirror get detached from RAG too
  for (const rel of Object.keys(state)) {
    if (seen.has(rel)) continue;
    await removeOwuiFile(state[rel].collection, state[rel].fileId).catch(() => {});
    delete state[rel];
    removed++;
    console.log(`[owui-sync] removed ${rel}`);
  }

  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(state, null, 1));
  console.log(`[owui-sync] done: +${pushed} -${removed} (skipped ${skipped})`);
}

void main().catch((e) => {
  console.error("[owui-sync] failed:", e);
  process.exitCode = 1;
});
