import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { saveUploadImage, extractSleepFromImage } from "@/lib/logs";

export const runtime = "nodejs";

const MAX_BYTES = 15_000_000; // 15 MB

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

/**
 * Upload a screenshot, vision-extract it, and return a DRAFT for review.
 * Nothing is saved to `logs` here — the client confirms via POST /api/logs.
 */
export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  const kind = (form.get("kind") as string) || "sleep";
  if (!(file instanceof File))
    return Response.json({ detail: "file required" }, { status: 400 });
  if (file.size === 0 || file.size > MAX_BYTES)
    return Response.json({ detail: "file empty or too large" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const abs = await saveUploadImage(buf, file.name || "upload.png");

  // Only sleep extraction is wired up so far; other kinds fall back to it.
  void kind;
  const result = await extractSleepFromImage(abs);

  // 200 even on extraction failure so the UI can show the error + raw text.
  return Response.json({
    ok: result.ok,
    draft: result.draft,
    error: result.error ?? null,
    raw: result.ok ? undefined : result.raw,
    jobId: result.jobId,
  });
}
