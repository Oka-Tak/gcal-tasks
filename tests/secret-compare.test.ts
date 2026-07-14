import assert from "node:assert/strict";
import test from "node:test";
import { secretMatches } from "../lib/secret-compare";

test("secretMatches accepts only an exact non-empty secret", () => {
  assert.equal(secretMatches("abc", "abc"), true);
  assert.equal(secretMatches("abcd", "abc"), false);
  assert.equal(secretMatches("", ""), false);
});
