import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { calendar_v3, tasks_v1 } from "googleapis";
import { db } from "./db";
import { calendars, events, tasklists, tasks } from "./db/schema";
import { calendarFor, tasksFor } from "./google";
import { listAccounts } from "./accounts";
import { collectGooglePages } from "./google-pagination";

/**
 * The mirror sync. Google is the source of truth for its own fields, so each
 * pull overwrites them; rows that vanished from Google (within the synced
 * window) are soft-deleted. Local-only task columns (dueTime, remindAt,
 * sortOrder) are never touched here — that's why they survive.
 */

function startMsOf(e: calendar_v3.Schema$Event): number | null {
  const s = e.start?.dateTime ?? e.start?.date;
  if (!s) return null;
  return e.start?.date ? Date.parse(`${s}T00:00:00`) : Date.parse(s);
}
function endMsOf(e: calendar_v3.Schema$Event): number | null {
  const s = e.end?.dateTime ?? e.end?.date;
  if (!s) return null;
  return e.end?.date ? Date.parse(`${s}T00:00:00`) : Date.parse(s);
}

function meetOf(e: calendar_v3.Schema$Event): string | null {
  if (e.hangoutLink) return e.hangoutLink;
  for (const ep of e.conferenceData?.entryPoints ?? []) {
    if (ep.entryPointType === "video" && ep.uri) return ep.uri;
  }
  return null;
}

export async function syncCalendars(email: string): Promise<void> {
  const runTs = Date.now();
  const cal = calendarFor(email);
  const items = await collectGooglePages<calendar_v3.Schema$CalendarListEntry>(async (pageToken) => {
    const res = await cal.calendarList.list({ pageToken });
    return res.data;
  });
  for (const c of items) {
    if (!c.id) continue;
    const row = {
      account: email,
      googleId: c.id,
      summary: c.summaryOverride ?? c.summary ?? null,
      color: c.backgroundColor ?? "#4285f4",
      primary: c.primary ?? false,
      accessRole: c.accessRole ?? null,
      selected: c.selected ?? true,
      syncedAt: runTs,
      deletedAt: null as number | null,
    };
    db.insert(calendars)
      .values(row)
      .onConflictDoUpdate({
        target: [calendars.account, calendars.googleId],
        set: row,
      })
      .run();
  }
  db.update(calendars)
    .set({ deletedAt: runTs })
    .where(
      and(
        eq(calendars.account, email),
        lt(calendars.syncedAt, runTs),
        isNull(calendars.deletedAt),
      ),
    )
    .run();
}

export async function syncEvents(
  email: string,
  calendarId: string,
  color: string,
  timeMin: string,
  timeMax: string,
): Promise<void> {
  const runTs = Date.now();
  const cal = calendarFor(email);
  let pageToken: string | undefined;
  do {
    const res = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
      pageToken,
    });
    for (const e of res.data.items ?? []) {
      if (!e.id || e.status === "cancelled") continue;
      const allDay = !!e.start?.date;
      const row = {
        account: email,
        calendarId,
        googleId: e.id,
        summary: e.summary ?? "(no title)",
        description: e.description ?? null,
        location: e.location ?? null,
        start: e.start?.dateTime ?? e.start?.date ?? null,
        end: e.end?.dateTime ?? e.end?.date ?? null,
        allDay,
        startMs: startMsOf(e),
        endMs: endMsOf(e),
        status: e.status ?? null,
        color,
        attendees: JSON.stringify(
          (e.attendees ?? []).map((a) => ({
            email: a.email,
            name: a.displayName,
            response: a.responseStatus,
            organizer: a.organizer ?? false,
            self: a.self ?? false,
            optional: a.optional ?? false,
          })),
        ),
        meet: meetOf(e),
        attachments: JSON.stringify(
          (e.attachments ?? []).map((a) => ({
            title: a.title,
            url: a.fileUrl,
            icon: a.iconLink,
          })),
        ),
        htmlLink: e.htmlLink ?? null,
        organizer: e.organizer?.email ?? null,
        recurring: !!e.recurringEventId,
        googleUpdated: e.updated ?? null,
        syncedAt: runTs,
        deletedAt: null as number | null,
      };
      db.insert(events)
        .values(row)
        .onConflictDoUpdate({
          target: [events.account, events.calendarId, events.googleId],
          set: row,
        })
        .run();
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const winMin = Date.parse(timeMin);
  const winMax = Date.parse(timeMax);
  // Soft-delete rows that overlap the synced window but weren't returned now.
  db.update(events)
    .set({ deletedAt: runTs })
    .where(
      and(
        eq(events.account, email),
        eq(events.calendarId, calendarId),
        lt(events.syncedAt, runTs),
        isNull(events.deletedAt),
        lt(events.startMs, winMax),
        gt(events.endMs, winMin),
      ),
    )
    .run();
}

export async function syncTasklists(email: string): Promise<tasks_v1.Schema$TaskList[]> {
  const runTs = Date.now();
  const api = tasksFor(email);
  const items = await collectGooglePages<tasks_v1.Schema$TaskList>(async (pageToken) => {
    const res = await api.tasklists.list({ maxResults: 100, pageToken });
    return res.data;
  });
  for (const l of items) {
    if (!l.id) continue;
    const row = {
      account: email,
      googleId: l.id,
      title: l.title ?? null,
      syncedAt: runTs,
      deletedAt: null as number | null,
    };
    db.insert(tasklists)
      .values(row)
      .onConflictDoUpdate({
        target: [tasklists.account, tasklists.googleId],
        set: row,
      })
      .run();
  }
  db.update(tasklists)
    .set({ deletedAt: runTs })
    .where(
      and(
        eq(tasklists.account, email),
        lt(tasklists.syncedAt, runTs),
        isNull(tasklists.deletedAt),
      ),
    )
    .run();
  return items;
}

export async function syncTasks(email: string, tasklistId: string): Promise<void> {
  const runTs = Date.now();
  const api = tasksFor(email);
  const items = await collectGooglePages<tasks_v1.Schema$Task>(async (pageToken) => {
    const res = await api.tasks.list({
      tasklist: tasklistId,
      showCompleted: true,
      showHidden: true,
      maxResults: 100,
      pageToken,
    });
    return res.data;
  });
  for (const t of items) {
    if (!t.id) continue;
    // Only Google-owned fields here. Local-only columns (dueTime, remindAt,
    // sortOrder) are intentionally absent from the conflict set so they survive.
    const googleFields = {
      title: t.title ?? "",
      notes: t.notes ?? null,
      status: t.status ?? "needsAction",
      due: t.due ?? null,
      position: t.position ?? null,
      parent: t.parent ?? null,
      googleUpdated: t.updated ?? null,
      syncedAt: runTs,
      deletedAt: null as number | null,
    };
    db.insert(tasks)
      .values({
        account: email,
        tasklist: tasklistId,
        googleId: t.id,
        ...googleFields,
      })
      .onConflictDoUpdate({
        target: [tasks.account, tasks.tasklist, tasks.googleId],
        set: googleFields,
      })
      .run();
  }
  db.update(tasks)
    .set({ deletedAt: runTs })
    .where(
      and(
        eq(tasks.account, email),
        eq(tasks.tasklist, tasklistId),
        lt(tasks.syncedAt, runTs),
        isNull(tasks.deletedAt),
      ),
    )
    .run();
}

/** Sync everything one account needs for a calendar window. */
export async function syncAccountRange(
  email: string,
  timeMin: string,
  timeMax: string,
): Promise<void> {
  await syncCalendars(email);
  const cals = db
    .select()
    .from(calendars)
    .where(and(eq(calendars.account, email), isNull(calendars.deletedAt)))
    .all();
  for (const c of cals) {
    await syncEvents(email, c.googleId, c.color ?? "#4285f4", timeMin, timeMax);
  }
  const lists = await syncTasklists(email);
  for (const l of lists) {
    if (l.id) await syncTasks(email, l.id);
  }
}

/** Sync all connected accounts for a window. Per-account failures are isolated. */
export async function syncAllRange(timeMin: string, timeMax: string): Promise<void> {
  for (const a of listAccounts()) {
    try {
      await syncAccountRange(a.email, timeMin, timeMax);
    } catch (e) {
      console.error(`[kairos] sync failed for ${a.email}:`, e);
    }
  }
}

/** Calendars + events only (the /api/events path; tasks sync via /api/tasks). */
export async function syncAllEvents(timeMin: string, timeMax: string): Promise<void> {
  for (const a of listAccounts()) {
    try {
      await syncCalendars(a.email);
      const cals = db
        .select()
        .from(calendars)
        .where(and(eq(calendars.account, a.email), isNull(calendars.deletedAt)))
        .all();
      for (const c of cals) {
        await syncEvents(a.email, c.googleId, c.color ?? "#4285f4", timeMin, timeMax);
      }
    } catch (e) {
      console.error(`[kairos] event sync failed for ${a.email}:`, e);
    }
  }
}
