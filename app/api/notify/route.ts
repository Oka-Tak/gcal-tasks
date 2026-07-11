import { auth } from "@/auth";
import { pushEnabled, sendPush } from "@/lib/notify";
import { loadMuteKeywords, saveMuteKeywords } from "@/lib/notify-mute";
import { env } from "@/lib/env";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/** Notification status (for the settings UI). */
export async function GET() {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  return Response.json({ enabled: pushEnabled(), mute: loadMuteKeywords() });
}

/** Save mute keywords (titles containing them are excluded from pushes). */
export async function PUT(req: Request) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { mute?: unknown } | null;
  if (!body || !Array.isArray(body.mute) || !body.mute.every((k) => typeof k === "string"))
    return Response.json({ detail: "mute must be string[]" }, { status: 400 });
  const saved = await saveMuteKeywords(body.mute as string[]);
  return Response.json({ mute: saved });
}

/** Send a test push so the phone-side subscription can be verified. */
export async function POST() {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const r = await sendPush({
    title: "Kairos テスト通知",
    message: "この通知が見えていればセットアップ完了です 🎉",
    tags: ["tada"],
    click: env.baseUrl,
  });
  return Response.json(r, { status: r.ok ? 200 : 503 });
}
