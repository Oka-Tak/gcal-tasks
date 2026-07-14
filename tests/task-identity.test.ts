import assert from "node:assert/strict";
import test from "node:test";
import { parentTaskIdentity, taskIdentity } from "../lib/task-identity";

test("task identities include account and tasklist", () => {
  const a = taskIdentity({ account: "a", tasklist: "one", googleId: "same" });
  const b = taskIdentity({ account: "b", tasklist: "one", googleId: "same" });
  const c = taskIdentity({ account: "a", tasklist: "two", googleId: "same" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("child parent identity matches only its scoped parent", () => {
  const parent = { account: "a", tasklist: "one", googleId: "parent" };
  assert.equal(
    parentTaskIdentity({ ...parent, googleId: "child", parent: "parent" }),
    taskIdentity(parent),
  );
  assert.notEqual(
    parentTaskIdentity({ account: "b", tasklist: "one", googleId: "child", parent: "parent" }),
    taskIdentity(parent),
  );
});
