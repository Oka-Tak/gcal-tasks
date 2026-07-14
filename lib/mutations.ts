import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { calendars, events, tasklists, tasks } from "./db/schema";
import { calendarFor, tasksFor } from "./google";
import { syncEvents, syncTasks } from "./sync";
import { eventRequestBody, taskRequestBody } from "./serialize";
import { InputError, validateEventWrite, validateTaskWrite } from "./write-validation";

/**
 * The ONE write-through path for tasks and events, shared by the REST routes
 * and the agent-action executor (lib/actions). Keeping this single is what
 * protects the local-only column dance: Google write → re-sync (which preserves
 * local-only columns) → apply local-only patch directly to the DB.
 */

export interface TaskWrite {
  account: string;
  tasklist: string;
  id?: string;
  parent?: string | null; // create as a subtask of this task (Google-native, 1 level only)
  // Google-owned fields:
  title?: string;
  notes?: string | null;
  status?: string; // needsAction | completed
  due?: string | null; // YYYY-MM-DD (date-only; Google can't hold a time)
  // Local-only fields (never sent to Google; see schema.ts):
  dueTime?: string | null; // 'HH:MM'
  estimatedMin?: number | null;
  actualMin?: number | null;
  difficulty?: number | null;
  energy?: number | null;
  kanban?: string | null; // board column: todo | doing | waiting
  remindAt?: number | null; // epoch ms — ntfy reminder time
  asap?: boolean | null; // 期限ASAP
  priority?: number | null; // 1(低)〜5(最優先)
}

const TASK_GOOGLE_FIELDS = ["title", "notes", "status", "due"] as const;
const TASK_LOCAL_FIELDS = [
  "dueTime",
  "estimatedMin",
  "actualMin",
  "difficulty",
  "energy",
  "kanban",
  "asap",
  "priority",
] as const;

/** Pick the local-only columns present in the payload ("key present" = set it). */
function taskLocalPatch(b: TaskWrite): Partial<typeof tasks.$inferInsert> {
  const patch: Record<string, unknown> = {};
  for (const k of TASK_LOCAL_FIELDS) {
    if (k in b) patch[k] = b[k] ?? null;
  }
  // A (re)scheduled reminder must fire again: reset the fired marker.
  if ("remindAt" in b) {
    patch.remindAt = b.remindAt ?? null;
    patch.remindedAt = null;
  }
  return patch as Partial<typeof tasks.$inferInsert>;
}

function applyTaskLocal(account: string, tasklist: string, id: string, b: TaskWrite): void {
  const patch = taskLocalPatch(b);
  if (Object.keys(patch).length === 0) return;
  db.update(tasks)
    .set(patch)
    .where(
      and(eq(tasks.account, account), eq(tasks.tasklist, tasklist), eq(tasks.googleId, id)),
    )
    .run();
}

export async function createTask(b: TaskWrite): Promise<{ id: string }> {
  b = validateTaskWrite(b, "create");
  assertTaskTarget(b, false);
  const created = await tasksFor(b.account).tasks.insert({
    tasklist: b.tasklist,
    parent: b.parent ?? undefined, // Google-native subtask (sub-issue)
    requestBody: taskRequestBody(b),
  });
  await syncTasks(b.account, b.tasklist);
  const id = created.data.id;
  if (!id) throw new Error("Google Tasks returned no id");
  applyTaskLocal(b.account, b.tasklist, id, b);
  return { id };
}

/**
 * Insert many tasks into ONE (account, tasklist) with a single sync at the end.
 * createTask() syncs the whole list per task, so bulk imports (gakujo 課題) would
 * do N full syncs and blow the request timeout — this does N inserts + 1 sync.
 * Returns how many succeeded.
 */
export async function createTasksBulk(list: TaskWrite[]): Promise<number> {
  if (!list.length) return 0;
  list = list.map((item) => validateTaskWrite(item, "create"));
  const { account, tasklist } = list[0];
  if (list.some((item) => item.account !== account || item.tasklist !== tasklist)) {
    throw new InputError("bulk tasks must use one account and tasklist");
  }
  for (const item of list) assertTaskTarget(item, false);
  const api = tasksFor(account);
  const done: { id: string; b: TaskWrite }[] = [];
  for (const b of list) {
    try {
      const created = await api.tasks.insert({
        tasklist,
        parent: b.parent ?? undefined,
        requestBody: taskRequestBody(b),
      });
      if (created.data.id) done.push({ id: created.data.id, b });
    } catch (e) {
      console.error("[bulk] insert failed:", String(e).slice(0, 160));
    }
  }
  await syncTasks(account, tasklist); // 1回だけ
  for (const { id, b } of done) applyTaskLocal(account, tasklist, id, b); // local-only列を復元
  return done.length;
}

export async function updateTask(b: TaskWrite & { id: string }): Promise<void> {
  b = validateTaskWrite(b, "update") as TaskWrite & { id: string };
  assertTaskTarget(b, true);
  // Only call Google when a Google-owned field changed; local-only fields never go out.
  const hasGoogle = TASK_GOOGLE_FIELDS.some((k) => k in b);
  if (hasGoogle) {
    await tasksFor(b.account).tasks.patch({
      tasklist: b.tasklist,
      task: b.id,
      requestBody: taskRequestBody(b),
    });
  }
  await syncTasks(b.account, b.tasklist); // refresh Google fields, preserve local-only
  applyTaskLocal(b.account, b.tasklist, b.id, b);
}

export interface EventWrite {
  account: string;
  calendarId: string;
  id?: string;
  summary?: string;
  location?: string | null;
  description?: string | null;
  allDay?: boolean;
  start: string; // RFC3339 dateTime, or YYYY-MM-DD when allDay
  end: string;
}

function calColor(account: string, calendarId: string): string {
  const row = db
    .select({ color: calendars.color })
    .from(calendars)
    .where(and(eq(calendars.account, account), eq(calendars.googleId, calendarId)))
    .get();
  return row?.color ?? "#4285f4";
}

function assertTaskTarget(b: TaskWrite, requireTask: boolean): void {
  const list = db.select({ deletedAt: tasklists.deletedAt })
    .from(tasklists)
    .where(and(eq(tasklists.account, b.account), eq(tasklists.googleId, b.tasklist)))
    .get();
  if (!list || list.deletedAt != null) throw new InputError("tasklist does not exist");

  if (requireTask) {
    const row = db.select({ deletedAt: tasks.deletedAt, due: tasks.due })
      .from(tasks)
      .where(and(eq(tasks.account, b.account), eq(tasks.tasklist, b.tasklist), eq(tasks.googleId, b.id!)))
      .get();
    if (!row || row.deletedAt != null) throw new InputError("task does not exist");
    const effectiveDue = b.due === undefined ? row.due : b.due;
    if (b.dueTime && !effectiveDue) throw new InputError("dueTime requires due");
  }
  if (b.parent) {
    const parent = db.select({ parent: tasks.parent, deletedAt: tasks.deletedAt })
      .from(tasks)
      .where(and(eq(tasks.account, b.account), eq(tasks.tasklist, b.tasklist), eq(tasks.googleId, b.parent)))
      .get();
    if (!parent || parent.deletedAt != null) throw new InputError("parent task does not exist");
    if (parent.parent) throw new InputError("nested subtasks are not supported");
  }
}

function assertCalendarTarget(account: string, calendarId: string, eventId?: string): void {
  const calendar = db.select({ accessRole: calendars.accessRole, deletedAt: calendars.deletedAt })
    .from(calendars)
    .where(and(eq(calendars.account, account), eq(calendars.googleId, calendarId)))
    .get();
  if (!calendar || calendar.deletedAt != null || !["owner", "writer"].includes(calendar.accessRole ?? "")) {
    throw new InputError("calendar is not writable");
  }
  if (eventId) {
    const event = db.select({ deletedAt: events.deletedAt })
      .from(events)
      .where(and(eq(events.account, account), eq(events.calendarId, calendarId), eq(events.googleId, eventId)))
      .get();
    if (!event || event.deletedAt != null) throw new InputError("event does not exist");
  }
}

// Generous window around an edited event so the re-sync captures it.
function windowAround(start: string, end: string) {
  const min = new Date(Date.parse(start) - 86_400_000).toISOString();
  const max = new Date(Date.parse(end) + 86_400_000).toISOString();
  return { min, max };
}

export async function createEvent(b: EventWrite): Promise<{ id: string }> {
  b = validateEventWrite(b, "create");
  assertCalendarTarget(b.account, b.calendarId);
  const created = await calendarFor(b.account).events.insert({
    calendarId: b.calendarId,
    requestBody: eventRequestBody(b),
  });
  const w = windowAround(b.start, b.end);
  await syncEvents(b.account, b.calendarId, calColor(b.account, b.calendarId), w.min, w.max);
  const id = created.data.id;
  if (!id) throw new Error("Google Calendar returned no id");
  return { id };
}

export async function updateEvent(b: EventWrite & { id: string }): Promise<void> {
  b = validateEventWrite(b, "update") as EventWrite & { id: string };
  assertCalendarTarget(b.account, b.calendarId, b.id);
  await calendarFor(b.account).events.patch({
    calendarId: b.calendarId,
    eventId: b.id,
    requestBody: eventRequestBody(b),
  });
  const w = windowAround(b.start, b.end);
  await syncEvents(b.account, b.calendarId, calColor(b.account, b.calendarId), w.min, w.max);
}
