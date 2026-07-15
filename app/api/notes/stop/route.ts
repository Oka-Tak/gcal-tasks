import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { stopTranscription } from "@/lib/notes";

export const runtime = "nodejs";

/** POST {id} — 実行中の文字起こしを停止（音源は残る。🔁/♻で再開可能）。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!b?.id) return Response.json({ detail: "id required" }, { status: 400 });
  const ok = stopTranscription(b.id);
  if (!ok) return Response.json({ detail: "文字起こし中のノートではありません" }, { status: 409 });
  return Response.json({ ok: true });
}
