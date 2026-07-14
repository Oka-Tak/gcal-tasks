import assert from "node:assert/strict";
import test from "node:test";
import { eventOverlapsDay, eventSegmentForDay } from "../lib/calendar-segments";

const day = new Date("2026-07-14T00:00:00+09:00").getTime();

test("eventSegmentForDay clips an overnight event on both days", () => {
  const start = new Date("2026-07-14T23:30:00+09:00").getTime();
  const end = new Date("2026-07-15T01:00:00+09:00").getTime();
  assert.deepEqual(eventSegmentForDay(start, end, day), { startMinute: 1410, endMinute: 1440 });
  assert.deepEqual(eventSegmentForDay(start, end, day + 86_400_000), { startMinute: 0, endMinute: 60 });
});

test("eventOverlapsDay excludes a boundary-touching event", () => {
  assert.equal(eventOverlapsDay(day - 60_000, day, day), false);
  assert.equal(eventOverlapsDay(day + 86_400_000, day + 86_460_000, day), false);
});
