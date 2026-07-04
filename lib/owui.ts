import { env } from "./env";

/**
 * Push notes into Open WebUI's Knowledge (the NotebookLM layer): the
 * 「Kairos ノート」 collection becomes queryable from the :443 chat via
 * "#Kairos ノート". Loopback-only; WEBUI_AUTH=False means an empty signin
 * yields an admin token. All of this is best-effort — a down Open WebUI
 * must never fail a note.
 */

const DEFAULT_COLLECTION = "Kairos ノート";

const g = globalThis as unknown as { __owuiToken?: string; __owuiKids?: Map<string, string> };

async function owuiFetch(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  return fetch(`${env.owuiUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function getToken(): Promise<string> {
  if (g.__owuiToken) {
    // cheap validity probe; tokens are long-lived but survive restarts poorly
    const r = await owuiFetch("/api/v1/auths/", {}, g.__owuiToken);
    if (r.ok) return g.__owuiToken;
    g.__owuiToken = undefined;
  }
  const r = await owuiFetch("/api/v1/auths/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "", password: "" }),
  });
  if (!r.ok) throw new Error(`owui signin: HTTP ${r.status}`);
  const d = (await r.json()) as { token?: string };
  if (!d.token) throw new Error("owui signin: no token (auth enabled?)");
  g.__owuiToken = d.token;
  return d.token;
}

async function getCollectionId(token: string, name: string): Promise<string> {
  const cache = (g.__owuiKids ??= new Map());
  const hitCached = cache.get(name);
  if (hitCached) return hitCached;
  const list = await owuiFetch("/api/v1/knowledge/", {}, token);
  if (list.ok) {
    const raw = (await list.json()) as
      | { id: string; name: string }[]
      | { items: { id: string; name: string }[] };
    const items = Array.isArray(raw) ? raw : (raw.items ?? []);
    const hit = items.find((k) => k.name === name);
    if (hit) {
      cache.set(name, hit.id);
      return hit.id;
    }
  }
  const create = await owuiFetch("/api/v1/knowledge/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: "Kairos のノート・文字起こし（自動同期）",
    }),
  }, token);
  if (!create.ok) throw new Error(`owui knowledge create: HTTP ${create.status}`);
  const d = (await create.json()) as { id: string };
  cache.set(name, d.id);
  return d.id;
}

/** MIME guesses for the types Open WebUI's loaders handle well. */
const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
};

export function owuiSupportedExt(ext: string): boolean {
  return ext.toLowerCase() in MIME;
}

/**
 * Upload an arbitrary local file into a collection (the OneDrive sync path).
 * Returns the Open WebUI file id so callers can replace it on change.
 * Unlike pushNoteToOwui this THROWS on failure — the sync job tracks state
 * and must not record a push that didn't happen.
 */
export async function pushLocalFileToOwui(
  buf: Buffer,
  filename: string,
  collection: string,
): Promise<string> {
  const token = await getToken();
  const kid = await getCollectionId(token, collection);
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buf)], { type: MIME[ext] ?? "application/octet-stream" }), filename);
  const up = await owuiFetch("/api/v1/files/", { method: "POST", body: fd }, token);
  if (!up.ok) throw new Error(`owui file upload: HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);
  const file = (await up.json()) as { id: string };
  const add = await owuiFetch(`/api/v1/knowledge/${kid}/file/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: file.id }),
  }, token);
  if (!add.ok) {
    // e.g. image-only slides → "content is empty". Remove the orphaned upload.
    await owuiFetch(`/api/v1/files/${file.id}`, { method: "DELETE" }, token).catch(() => {});
    throw new Error(`owui knowledge add: HTTP ${add.status} ${(await add.text()).slice(0, 200)}`);
  }
  return file.id;
}

/** Detach a file from a collection and delete it (stale/changed sync entries). */
export async function removeOwuiFile(collection: string, fileId: string): Promise<void> {
  const token = await getToken();
  const kid = await getCollectionId(token, collection);
  await owuiFetch(`/api/v1/knowledge/${kid}/file/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  }, token);
  await owuiFetch(`/api/v1/files/${fileId}`, { method: "DELETE" }, token);
}

/**
 * Upload one note as a markdown file and attach it to a collection.
 * `collection` is the notebook: per-course for event-attached notes
 * (講義: 経営管理), the catch-all otherwise.
 */
export async function pushNoteToOwui(note: {
  id: string;
  title: string | null;
  content: string | null;
  transcript: string | null;
}, collection?: string | null): Promise<void> {
  const name = (collection ?? "").trim() || DEFAULT_COLLECTION;
  try {
    const token = await getToken();
    const kid = await getCollectionId(token, name);

    const md = [
      `# ${note.title ?? "(無題)"}`,
      "",
      note.content ?? "",
      ...(note.transcript ? ["", "## 文字起こし全文", note.transcript] : []),
    ].join("\n");

    const fd = new FormData();
    fd.append(
      "file",
      new Blob([md], { type: "text/markdown" }),
      `kairos-note-${note.id}.md`,
    );
    const up = await owuiFetch("/api/v1/files/", { method: "POST", body: fd }, token);
    if (!up.ok) throw new Error(`owui file upload: HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);
    const file = (await up.json()) as { id: string };

    const add = await owuiFetch(`/api/v1/knowledge/${kid}/file/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: file.id }),
    }, token);
    if (!add.ok) throw new Error(`owui knowledge add: HTTP ${add.status} ${(await add.text()).slice(0, 200)}`);
    console.log(`[owui] note ${note.id} indexed into "${name}"`);
  } catch (e) {
    console.error("[owui] push failed (note kept locally):", e);
  }
}
