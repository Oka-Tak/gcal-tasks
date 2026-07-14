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

async function owuiFetch(path: string, init: RequestInit = {}, token?: string, timeoutMs = 120_000): Promise<Response> {
  // OWUIは大きい文書の埋め込み・ベクタ挿入中イベントループごと固まることが
  // ある。タイムアウト無しだと呼び出し側(owui-sync等)が永久に待って
  // ハングするので、必ず打ち切る（呼び出し側はtransientとして再試行）。
  return fetch(`${env.owuiUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
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

/**
 * 全ナレッジをベクタ検索してチャンクを返す（task-enrich のRAG用）。
 * OWUIが落ちていても空配列で静かに退避する。
 */
export async function searchKnowledge(
  query: string,
  k = 6,
): Promise<{ text: string; src: string }[]> {
  try {
    const token = await getToken();
    const list = await owuiFetch("/api/v1/knowledge/", {}, token);
    if (!list.ok) return [];
    const raw = (await list.json()) as { id: string; name: string }[] | { items: { id: string; name: string }[] };
    const kbs = Array.isArray(raw) ? raw : (raw.items ?? []);
    if (kbs.length === 0) return [];
    const byId = new Map(kbs.map((x) => [x.id, x.name]));
    const r = await owuiFetch("/api/v1/retrieval/query/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection_names: kbs.map((x) => x.id), query: query.slice(0, 600), k }),
    }, token, 30_000);
    if (!r.ok) return [];
    const d = (await r.json()) as { documents?: string[][]; metadatas?: Record<string, unknown>[][] };
    const docs = d.documents?.[0] ?? [];
    const metas = d.metadatas?.[0] ?? [];
    return docs.slice(0, k).map((text, i) => {
      const m = metas[i] ?? {};
      const col = byId.get(String(m.collection_name ?? "")) ?? "";
      return { text: text.trim().slice(0, 1200), src: `${String(m.name ?? m.source ?? "資料")}${col ? `（${col}）` : ""}` };
    });
  } catch {
    return [];
  }
}

export function owuiSupportedExt(ext: string): boolean {
  return ext.toLowerCase() in MIME;
}

/** Poll a freshly-uploaded file until OWUI has finished extracting its text. */
async function waitForFileReady(token: string, fileId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const r = await owuiFetch(`/api/v1/files/${fileId}`, {}, token);
    if (r.ok) {
      const d = (await r.json()) as { data?: { status?: string; content?: string } };
      const status = d.data?.status;
      const hasContent = !!(d.data?.content && d.data.content.trim());
      if (status === "completed" || hasContent) return;
      if (status === "failed") return; // let the add step surface the real error
    }
    await new Promise((res) => setTimeout(res, 750));
  }
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
  // OWUI extracts file text ASYNChronously; adding to a collection before it
  // finishes gets rejected as "content empty". Wait for the extraction to land.
  await waitForFileReady(token, file.id);
  // add はOWUI側で埋め込みまで同期実行される最重量の呼び出し — 長めに待つ
  const add = await owuiFetch(`/api/v1/knowledge/${kid}/file/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: file.id }),
  }, token, 300_000);
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
 * `replaceFileId` = 既存登録の置き換え（編集の再同期）。
 * Returns the new OWUI file id (null on failure — the note stays local-only).
 */
export async function pushNoteToOwui(note: {
  id: string;
  title: string | null;
  content: string | null;
  transcript: string | null;
}, collection?: string | null, replaceFileId?: string | null): Promise<string | null> {
  const name = (collection ?? "").trim() || DEFAULT_COLLECTION;
  try {
    const token = await getToken();
    const kid = await getCollectionId(token, name);
    if (replaceFileId) {
      await removeOwuiFile(name, replaceFileId).catch(() => {});
    } else {
      // owuiFileId を記録する前の時代に登録したコピーが残っていると編集の
      // たびに増殖する — 同名ファイルをコレクションから探して掃除する
      try {
        const kr = await owuiFetch(`/api/v1/knowledge/${kid}`, {}, token);
        if (kr.ok) {
          const kd = (await kr.json()) as { files?: { id: string; meta?: { name?: string } }[] };
          for (const f of kd.files ?? []) {
            if (f.meta?.name === `kairos-note-${note.id}.md`) await removeOwuiFile(name, f.id).catch(() => {});
          }
        }
      } catch { /* 掃除失敗は増殖許容 */ }
    }

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
    await waitForFileReady(token, file.id); // 抽出完了前のaddは "content empty" で弾かれる

    const add = await owuiFetch(`/api/v1/knowledge/${kid}/file/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: file.id }),
    }, token);
    if (!add.ok) {
      // 孤児を残すと同内容の再pushが永遠に "Duplicate content" で弾かれる
      await owuiFetch(`/api/v1/files/${file.id}`, { method: "DELETE" }, token).catch(() => {});
      throw new Error(`owui knowledge add: HTTP ${add.status} ${(await add.text()).slice(0, 200)}`);
    }
    console.log(`[owui] note ${note.id} indexed into "${name}"`);
    return file.id;
  } catch (e) {
    console.error("[owui] push failed (note kept locally):", e);
    return null;
  }
}
