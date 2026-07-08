import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { calendars, tasks } from "./db/schema";
import { calendarFor, tasksFor } from "./google";
import { syncEvents, syncTasks } from "./sync";
import { eventRequestBody, taskRequestBody } from "./serialize";

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
}

const TASK_GOOGLE_FIELDS = ["title", "notes", "status", "due"] as const;
const TASK_LOCAL_FIELDS = [
  "dueTime",
  "estimatedMin",
  "actualMin",
  "difficulty",
  "energy",
  "kanban",
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
  const { account, tasklist } = list[0];
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

// Generous window around an edited event so the re-sync captures it.
function windowAround(start: string, end: string) {
  const min = new Date(Date.parse(start) - 86_400_000).toISOString();
  const max = new Date(Date.parse(end) + 86_400_000).toISOString();
  return { min, max };
}

export async function createEvent(b: EventWrite): Promise<{ id: string }> {
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
  await calendarFor(b.account).events.patch({
    calendarId: b.calendarId,
    eventId: b.id,
    requestBody: eventRequestBody(b),
  });
  const w = windowAround(b.start, b.end);
  await syncEvents(b.account, b.calendarId, calColor(b.account, b.calendarId), w.min, w.max);
}
