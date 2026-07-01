import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { calendars, events } from "@/lib/db/schema";
import { calendarFor } from "@/lib/google";
import { syncAllEvents, syncEvents } from "@/lib/sync";
import { eventRequestBody, serializeEvent } from "@/lib/serialize";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

function calColor(account: string, calendarId: string): string {
  const row = db
    .select({ color: calendars.color })
    .from(calendars)
    .where(and(eq(calendars.account, account), eq(calendars.googleId, calendarId)))
    .get();
  return row?.color ?? "#4285f4";
}

// Generous window around an edited event so the re-sync captures it.
function windowAround(start: string, end: string) {
  const min = new Date(Date.parse(start) - 86_400_000).toISOString();
  const max = new Date(Date.parse(end) + 86_400_000).toISOString();
  return { min, max };
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
  const { account, calendarId } = body;
  if (!account || !calendarId)
    return Response.json({ detail: "account/calendarId required" }, { status: 400 });

  const created = await calendarFor(account).events.insert({
    calendarId,
    requestBody: eventRequestBody(body),
  });
  const w = windowAround(body.start, body.end);
  await syncEvents(account, calendarId, calColor(account, calendarId), w.min, w.max);
  return Response.json({ id: created.data.id });
}

export async function PATCH(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  const { account, calendarId, id } = body;
  if (!account || !calendarId || !id)
    return Response.json({ detail: "account/calendarId/id required" }, { status: 400 });

  await calendarFor(account).events.patch({
    calendarId,
    eventId: id,
    requestBody: eventRequestBody(body),
  });
  const w = windowAround(body.start, body.end);
  await syncEvents(account, calendarId, calColor(account, calendarId), w.min, w.max);
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
