import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { redoTranscription } from "@/lib/notes";

export const runtime = "nodejs";

/** POST {id, language?, audioId?} — 再文字起こし（audioId 指定でその音源だけ）。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const b = await req.json();
  if (typeof b.id !== "string") return Response.json({ detail: "id required" }, { status: 400 });
  const lang = typeof b.language === "string" && b.language.trim() ? b.language.trim() : "ja";
  const audioId = typeof b.audioId === "string" && b.audioId ? b.audioId : null;
  const ok = redoTranscription(b.id, lang, audioId);
  if (!ok) return Response.json({ detail: "音声が残っていないため再実行できません" }, { status: 422 });
  return Response.json({ ok: true });
}
