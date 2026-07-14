import assert from "node:assert/strict";
import test from "node:test";
import { isRoutineHm } from "../lib/routines";

test("routine time format rejects impossible clock values", () => {
  assert.equal(isRoutineHm("00:00"), true);
  assert.equal(isRoutineHm("23:59"), true);
  assert.equal(isRoutineHm("24:00"), false);
  assert.equal(isRoutineHm("12:99"), false);
});
