import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

/**
 * Connected Google accounts (data sources). One row per account; tokens are
 * encrypted at rest (see lib/crypto). This is NOT Auth.js's table — we manage
 * data-source tokens ourselves so multiple Google accounts attach cleanly.
 */
export const accounts = sqliteTable("accounts", {
  email: text("email").primaryKey(),
  name: text("name"),
  picture: text("picture"),
  color: text("color"),
  accessToken: text("access_token"), // encrypted
  refreshToken: text("refresh_token"), // encrypted
  expiresAt: integer("expires_at"), // epoch seconds
  scope: text("scope"),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

/** Mirror of each account's calendarList. */
export const calendars = sqliteTable(
  "calendars",
  {
    account: text("account").notNull(),
    googleId: text("google_id").notNull(),
    summary: text("summary"),
    color: text("color"),
    primary: integer("primary", { mode: "boolean" }),
    accessRole: text("access_role"),
    selected: integer("selected", { mode: "boolean" }),
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.account, t.googleId] })],
);

/** Mirror of calendar events (Google is source of truth for these fields). */
export const events = sqliteTable(
  "events",
  {
    account: text("account").notNull(),
    calendarId: text("calendar_id").notNull(),
    googleId: text("google_id").notNull(),
    summary: text("summary"),
    description: text("description"),
    location: text("location"),
    start: text("start"), // raw: rfc3339 dateTime, or YYYY-MM-DD for all-day
    end: text("end"),
    allDay: integer("all_day", { mode: "boolean" }),
    startMs: integer("start_ms"), // epoch ms for range queries
    endMs: integer("end_ms"),
    status: text("status"),
    color: text("color"),
    attendees: text("attendees"), // JSON string
    meet: text("meet"),
    attachments: text("attachments"), // JSON string
    htmlLink: text("html_link"),
    organizer: text("organizer"),
    recurring: integer("recurring", { mode: "boolean" }),
    googleUpdated: text("google_updated"),
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    primaryKey({ columns: [t.account, t.calendarId, t.googleId] }),
    index("events_range").on(t.startMs, t.endMs),
  ],
);

/** Mirror of each account's task lists. */
export const tasklists = sqliteTable(
  "tasklists",
  {
    account: text("account").notNull(),
    googleId: text("google_id").notNull(),
    title: text("title"),
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.account, t.googleId] })],
);

/**
 * Mirror of tasks PLUS local-only columns Google cannot store. `dueTime` is the
 * whole point of having a DB: Google Tasks holds date only, so the time-of-day
 * lives here and never round-trips to Google. Sync preserves these columns.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    account: text("account").notNull(),
    tasklist: text("tasklist").notNull(),
    googleId: text("google_id").notNull(),
    title: text("title"),
    notes: text("notes"),
    status: text("status"), // needsAction | completed
    due: text("due"), // date-only (rfc3339 midnight) from Google
    position: text("position"),
    parent: text("parent"),
    googleUpdated: text("google_updated"),
    // local-only (never sent to Google):
    dueTime: text("due_time"), // 'HH:MM'
    remindAt: integer("remind_at"), // epoch ms (future)
    sortOrder: integer("sort_order"), // local ordering (future)
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.account, t.tasklist, t.googleId] })],
);
