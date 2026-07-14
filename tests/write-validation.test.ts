import assert from "node:assert/strict";
import test from "node:test";
import { InputError, isValidYmd, validateEventWrite, validateTaskWrite } from "../lib/write-validation";

test("isValidYmd rejects normalized impossible dates", () => {
  assert.equal(isValidYmd("2026-02-28"), true);
  assert.equal(isValidYmd("2026-02-31"), false);
});

test("validateTaskWrite accepts the current task editor payload", () => {
  const task = validateTaskWrite({
    account: "me@example.com",
    tasklist: "list",
    title: "課題",
    due: "2026-07-20",
    dueTime: "23:30",
    estimatedMin: 60,
    priority: 4,
    asap: false,
  }, "create");
  assert.equal(task.dueTime, "23:30");
});

test("validateTaskWrite rejects invalid local fields", () => {
  assert.throws(
    () => validateTaskWrite({ account: "a", tasklist: "b", title: "x", dueTime: "25:00" }, "create"),
    InputError,
  );
  assert.throws(
    () => validateTaskWrite({ account: "a", tasklist: "b", title: "x", priority: 9 }, "create"),
    InputError,
  );
});

test("validateEventWrite enforces a real, increasing range", () => {
  assert.throws(
    () => validateEventWrite({ account: "a", calendarId: "c", summary: "x", allDay: true, start: "2026-02-31", end: "2026-03-02" }, "create"),
    InputError,
  );
  assert.throws(
    () => validateEventWrite({ account: "a", calendarId: "c", summary: "x", start: "2026-07-20T12:00:00+09:00", end: "2026-07-20T11:00:00+09:00" }, "create"),
    /start must be before end/,
  );
});
