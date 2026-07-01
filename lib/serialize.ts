import type { calendar_v3, tasks_v1 } from "googleapis";
import type { events as eventsTable, tasks as tasksTable } from "./db/schema";

type EventRow = typeof eventsTable.$inferSelect;
type TaskRow = typeof tasksTable.$inferSelect;

/** DB event row -> client shape (parses JSON columns). */
export function serializeEvent(r: EventRow) {
  return {
    account: r.account,
    id: r.googleId,
    calendarId: r.calendarId,
    color: r.color,
    summary: r.summary ?? "(no title)",
    location: r.location,
    description: r.description,
    allDay: !!r.allDay,
    start: r.start,
    end: r.end,
    attendees: safeParse(r.attendees, []),
    meet: r.meet,
    attachments: safeParse(r.attachments, []),
    htmlLink: r.htmlLink,
    organizer: r.organizer,
    recurring: !!r.recurring,
  };
}

/** DB task row -> client shape (includes local-only dueTime). */
export function serializeTask(r: TaskRow) {
  return {
    account: r.account,
    tasklist: r.tasklist,
    id: r.googleId,
    title: r.title ?? "",
    notes: r.notes,
    status: r.status ?? "needsAction",
    due: r.due,
    dueTime: r.dueTime, // local-only 'HH:MM'
    position: r.position,
    parent: r.parent,
  };
}

type EventPayload = {
  summary?: string;
  location?: string | null;
  description?: string | null;
  allDay?: boolean;
  start: string;
  end: string;
};

/** Client payload -> Google Calendar event resource (end exclusive for all-day). */
export function eventRequestBody(b: EventPayload): calendar_v3.Schema$Event {
  const ev: calendar_v3.Schema$Event = { summary: b.summary ?? "" };
  if (b.location != null) ev.location = b.location;
  if (b.description != null) ev.description = b.description;
  if (b.allDay) {
    ev.start = { date: b.start.slice(0, 10) };
    ev.end = { date: b.end.slice(0, 10) };
  } else {
    ev.start = { dateTime: b.start };
    ev.end = { dateTime: b.end };
  }
  return ev;
}

type TaskPayload = {
  title?: string;
  notes?: string | null;
  status?: string;
  due?: string | null;
};

/** Client payload -> Google Tasks resource. Time-of-day is NOT sent (Google can't store it). */
export function taskRequestBody(b: TaskPayload): tasks_v1.Schema$Task {
  const out: tasks_v1.Schema$Task = {};
  if (b.title !== undefined) out.title = b.title;
  if (b.notes !== undefined) out.notes = b.notes;
  if (b.status !== undefined) out.status = b.status;
  if (b.due !== undefined) {
    out.due = b.due ? `${b.due.slice(0, 10)}T00:00:00.000Z` : null;
  }
  return out;
}

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
