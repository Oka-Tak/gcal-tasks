import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { deleteRoutine, listRoutines, seedRoutines, upsertRoutine } from "@/lib/routines";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

export async function GET() {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  seedRoutines(); // 初回だけ例をまく
  return Response.json({ routines: listRoutines() });
}

/** POST {id?, label, kind, days?, startHm?, endHm?, note?, active?} → upsert */
export async function POST(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  try {
    const routine = upsertRoutine(await req.json());
    return Response.json({ routine });
  } catch (e) {
    return Response.json({ detail: String((e as Error).message ?? e) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser())) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ detail: "id required" }, { status: 400 });
  deleteRoutine(id);
  return new Response(null, { status: 204 });
}
