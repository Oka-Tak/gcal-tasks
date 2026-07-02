import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { events } from "@/lib/db/schema";
import { calendarFor } from "@/lib/google";
import { syncAllEvents } from "@/lib/sync";
import { serializeEvent } from "@/lib/serialize";
import { createEvent, updateEvent } from "@/lib/mutations";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const timeMin = sp.get("timeMin");
  const timeMax = sp.get("timeMax");
  if (!timeMin || !timeMax)
    return Response.json({ detail: "timeMin/timeMax required" }, { status: 400 });

  await syncAllEvents(timeMin, timeMax);

  const winMin = Date.parse(timeMin);
  const winMax = Date.parse(timeMax);
  const rows = db
    .select()
    .from(events)
    .where(
      and(isNull(events.deletedAt), lt(events.startMs, winMax), gt(events.endMs, winMin)),
    )
    .all();
  return Response.json(rows.map(serializeEvent));
}

export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  if (!body.account || !body.calendarId)
    return Response.json({ detail: "account/calendarId required" }, { status: 400 });

  const created = await createEvent(body);
  return Response.json({ id: created.id });
}

export async function PATCH(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  if (!body.account || !body.calendarId || !body.id)
    return Response.json({ detail: "account/calendarId/id required" }, { status: 400 });

  await updateEvent(body);
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const account = sp.get("account");
  const calendarId = sp.get("calendarId");
  const id = sp.get("id");
  if (!account || !calendarId || !id)
    return Response.json({ detail: "account/calendarId/id required" }, { status: 400 });

  await calendarFor(account).events.delete({ calendarId, eventId: id });
  db.update(events)
    .set({ deletedAt: Date.now() })
    .where(
      and(
        eq(events.account, account),
        eq(events.calendarId, calendarId),
        eq(events.googleId, id),
      ),
    )
    .run();
  return Response.json({ ok: true });
}
