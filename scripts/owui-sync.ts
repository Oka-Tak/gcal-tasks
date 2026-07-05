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

  // ROOT holds one dir per Syncthing share. The user shares their whole
  // OneDrive root, so the meaningful grouping is one level down: each
  // share's top-level dir becomes a collection ("OneDrive: 授業資料"),
  // loose files in the share root go to "OneDrive: その他".
  let shares: string[] = [];
  try {
    shares = (await fs.readdir(ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    console.log(`[owui-sync] sync root not ready: ${ROOT}`);
    return;
  }

  const jobs: { abs: string; rel: string; collection: string }[] = [];
  for (const share of shares) {
    const shareAbs = path.join(ROOT, share);
    for (const e of await fs.readdir(shareAbs, { withFileTypes: true })) {
      if (e.name.startsWith(".st") || e.name.startsWith(".")) continue;
      const abs = path.join(shareAbs, e.name);
      if (e.isDirectory()) {
        for await (const f of walk(abs)) {
          jobs.push({ abs: f, rel: path.relative(ROOT, f), collection: `OneDrive: ${e.name}` });
        }
      } else if (e.isFile()) {
        jobs.push({ abs, rel: path.relative(ROOT, abs), collection: "OneDrive: その他" });
      }
    }
  }

  const saveState = async () => {
    await fs.mkdir(path.dirname(STATE), { recursive: true });
    await fs.writeFile(STATE, JSON.stringify(state, null, 1));
  };

  let failed = 0;
  let sinceSave = 0;
  for (const { abs, rel, collection } of jobs) {
    seen.add(rel);
    const ext = path.extname(abs);
    if (!owuiSupportedExt(ext)) { skipped++; continue; }
    const st = await fs.stat(abs);
    if (st.size === 0 || st.size > MAX_BYTES) { skipped++; continue; }
    const prev = state[rel];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue; // unchanged (or known-bad)

    if (prev?.fileId) await removeOwuiFile(prev.collection, prev.fileId).catch(() => {});
    // flatten the path below the top dir into the filename so citations stay readable
    const filename = rel.split(path.sep).slice(2).join("__") || path.basename(abs);
    try {
      const fileId = await pushLocalFileToOwui(await fs.readFile(abs), filename, collection);
      state[rel] = { mtimeMs: st.mtimeMs, size: st.size, fileId, collection };
      pushed++;
      console.log(`[owui-sync] pushed ${rel} → "${collection}"`);
    } catch (e) {
      // unparseable content (image-only slides etc.) — record so we don't retry
      // every run; a changed mtime clears the marker
      failed++;
      state[rel] = { mtimeMs: st.mtimeMs, size: st.size, fileId: "", collection };
      console.log(`[owui-sync] FAILED ${rel}: ${String(e).slice(0, 140)}`);
    }
    // the initial index runs for hours — persist progress so a kill resumes
    if (++sinceSave >= 25) {
      sinceSave = 0;
      await saveState();
    }
  }

  // files that vanished from the mirror get detached from RAG too
  for (const rel of Object.keys(state)) {
    if (seen.has(rel)) continue;
    if (state[rel].fileId) await removeOwuiFile(state[rel].collection, state[rel].fileId).catch(() => {});
    delete state[rel];
    removed++;
    console.log(`[owui-sync] removed ${rel}`);
  }

  await saveState();
  console.log(`[owui-sync] done: +${pushed} -${removed} (skipped ${skipped}, failed ${failed})`);
}

void main().catch((e) => {
  console.error("[owui-sync] failed:", e);
  process.exitCode = 1;
});
