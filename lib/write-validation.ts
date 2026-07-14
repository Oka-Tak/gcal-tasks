import type { EventWrite, TaskWrite } from "./mutations";

type Raw = Record<string, unknown>;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function record(value: unknown): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("request body must be an object");
  }
  return value as Raw;
}

function requiredString(r: Raw, key: string, max = 2048): string {
  const value = r[key];
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${key} is required`);
  if (value.length > max) throw new InputError(`${key} is too long`);
  return value.trim();
}

function optionalString(r: Raw, key: string, max: number): string | null | undefined {
  if (!(key in r)) return undefined;
  const value = r[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new InputError(`${key} must be a string or null`);
  if (value.length > max) throw new InputError(`${key} is too long`);
  return value;
}

function optionalInt(r: Raw, key: string, min: number, max: number): number | null | undefined {
  if (!(key in r)) return undefined;
  const value = r[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${key} must be an integer between ${min} and ${max}, or null`);
  }
  return value;
}

export function isValidYmd(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateTaskWrite(value: unknown, mode: "create" | "update"): TaskWrite {
  const r = record(value);
  const out: TaskWrite = {
    account: requiredString(r, "account", 320),
    tasklist: requiredString(r, "tasklist"),
  };

  if (mode === "update") out.id = requiredString(r, "id");
  if (mode === "create") out.title = requiredString(r, "title", 4096);
  else if ("title" in r) out.title = requiredString(r, "title", 4096);

  const parent = optionalString(r, "parent", 2048);
  if (parent !== undefined) out.parent = parent;
  const notes = optionalString(r, "notes", 100_000);
  if (notes !== undefined) out.notes = notes;

  if ("status" in r) {
    if (r.status !== "needsAction" && r.status !== "completed") {
      throw new InputError('status must be "needsAction" or "completed"');
    }
    out.status = r.status;
  }

  if ("due" in r) {
    if (r.due !== null && (typeof r.due !== "string" || !isValidYmd(r.due))) {
      throw new InputError("due must be a real date in YYYY-MM-DD format, or null");
    }
    out.due = r.due as string | null;
  }
  if ("dueTime" in r) {
    if (r.dueTime !== null && (typeof r.dueTime !== "string" || !HM.test(r.dueTime))) {
      throw new InputError("dueTime must be HH:MM, or null");
    }
    out.dueTime = r.dueTime as string | null;
    const effectiveDue = "due" in r ? r.due : undefined;
    if (r.dueTime && (effectiveDue === null || (mode === "create" && effectiveDue === undefined))) {
      throw new InputError("dueTime requires due");
    }
  }

  for (const [key, min, max] of [
    ["estimatedMin", 1, 6000],
    ["actualMin", 1, 6000],
    ["difficulty", 1, 5],
    ["energy", 1, 5],
    ["priority", 1, 5],
  ] as const) {
    const n = optionalInt(r, key, min, max);
    if (n !== undefined) out[key] = n;
  }

  if ("kanban" in r) {
    if (r.kanban !== null && !["todo", "doing", "waiting"].includes(String(r.kanban))) {
      throw new InputError('kanban must be "todo", "doing", "waiting", or null');
    }
    out.kanban = r.kanban as string | null;
  }
  if ("remindAt" in r) {
    if (r.remindAt !== null && (typeof r.remindAt !== "number" || !Number.isFinite(r.remindAt) || r.remindAt < 0)) {
      throw new InputError("remindAt must be a non-negative epoch millisecond value, or null");
    }
    out.remindAt = r.remindAt as number | null;
  }
  if ("asap" in r) {
    if (r.asap !== null && typeof r.asap !== "boolean") throw new InputError("asap must be boolean or null");
    out.asap = r.asap as boolean | null;
  }
  return out;
}

function validDateTime(value: string): boolean {
  return value.includes("T") && Number.isFinite(Date.parse(value));
}

export function validateEventWrite(value: unknown, mode: "create" | "update"): EventWrite {
  const r = record(value);
  const allDay = r.allDay === true;
  if ("allDay" in r && typeof r.allDay !== "boolean") throw new InputError("allDay must be boolean");
  const start = requiredString(r, "start", 100);
  const end = requiredString(r, "end", 100);
  if (allDay ? !isValidYmd(start) || !isValidYmd(end) : !validDateTime(start) || !validDateTime(end)) {
    throw new InputError(allDay ? "all-day start/end must be YYYY-MM-DD" : "start/end must be RFC3339 datetimes");
  }
  if (Date.parse(start) >= Date.parse(end)) throw new InputError("start must be before end");

  const out: EventWrite = {
    account: requiredString(r, "account", 320),
    calendarId: requiredString(r, "calendarId"),
    start,
    end,
    allDay,
  };
  if (mode === "update") out.id = requiredString(r, "id");
  if (mode === "create") out.summary = requiredString(r, "summary", 4096);
  else if ("summary" in r) out.summary = requiredString(r, "summary", 4096);

  const description = optionalString(r, "description", 100_000);
  if (description !== undefined) out.description = description;
  const location = optionalString(r, "location", 10_000);
  if (location !== undefined) out.location = location;
  return out;
}
