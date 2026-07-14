import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { addMaterial, deleteMaterial, listMaterials, listNotebooks } from "@/lib/materials";
import { uploadSetError } from "@/lib/upload-limits";

export const runtime = "nodejs";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 50_000_000;
const MAX_TOTAL_BYTES = 200_000_000;

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** GET /api/materials[?notebook=…] → 一覧 + ノートブック候補 */
export async function GET(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const notebook = new URL(req.url).searchParams.get("notebook");
  return Response.json({ materials: listMaterials(notebook), notebooks: listNotebooks() });
}

/** POST multipart: files[] + (notebook | eventKey) → 追加してRAG登録 */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const uploadError = uploadSetError(files, { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
  if (uploadError) return Response.json({ detail: uploadError }, { status: 400 });
  const notebook = (form.get("notebook") as string | null)?.trim() || null;
  const eventKey = (form.get("eventKey") as string | null)?.trim() || null;
  const created = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      created.push(await addMaterial({
        buf: Buffer.from(await f.arrayBuffer()),
        filename: f.name || "file",
        notebook,
        eventKey,
      }));
    } catch (e) {
      errors.push(`${f.name}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
    }
  }
  return Response.json({ ok: errors.length === 0, created, errors });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  await deleteMaterial(id);
  return new Response(null, { status: 204 });
}
