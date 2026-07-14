import assert from "node:assert/strict";
import test from "node:test";
import { uploadSetError } from "../lib/upload-limits";

const limits = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };

test("uploadSetError accepts files within per-file and total limits", () => {
  assert.equal(uploadSetError([{ size: 7 }, { size: 8 }], limits), null);
});

test("uploadSetError rejects aggregate overflow", () => {
  assert.match(uploadSetError([{ size: 8 }, { size: 8 }], limits) ?? "", /total/);
});

test("uploadSetError rejects empty and excessive file sets", () => {
  assert.match(uploadSetError([], limits) ?? "", /required/);
  assert.match(uploadSetError([{ size: 1 }, { size: 1 }, { size: 1 }], limits) ?? "", /too many/);
});
