import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { deleteGlossary, listGlossary, pushGlossaryToOwui, seedGlossary, upsertGlossary } from "@/lib/glossary";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

export async function GET() {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  seedGlossary();
  return Response.json({ glossary: listGlossary() });
}

/** POST {id?, term, aliases?, definition?} → upsert（保存のたびRAGにも反映） */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  try {
    const row = upsertGlossary(await req.json());
    void pushGlossaryToOwui().catch(() => {});
    return Response.json({ row });
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  deleteGlossary(id);
  void pushGlossaryToOwui().catch(() => {});
  return new Response(null, { status: 204 });
}
