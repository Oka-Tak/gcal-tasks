import { isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { calendars } from "@/lib/db/schema";

export const runtime = "nodejs";

/** Calendars from the mirror (populated by the events sync). */
export async function GET() {
  const session = await auth();
  if (!session?.user)
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const rows = db
    .select()
    .from(calendars)
    .where(isNull(calendars.deletedAt))
    .all()
    .map((c) => ({
      account: c.account,
      id: c.googleId,
      summary: c.summary,
      color: c.color,
      primary: !!c.primary,
    }));
  return Response.json(rows);
}
