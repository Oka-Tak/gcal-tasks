import assert from "node:assert/strict";
import test from "node:test";
import { collectGooglePages } from "../lib/google-pagination";

test("collectGooglePages returns every item in page order", async () => {
  const requested: Array<string | undefined> = [];
  const items = await collectGooglePages(async (pageToken) => {
    requested.push(pageToken);
    if (!pageToken) return { items: [1, 2], nextPageToken: "page-2" };
    return { items: [3], nextPageToken: null };
  });

  assert.deepEqual(requested, [undefined, "page-2"]);
  assert.deepEqual(items, [1, 2, 3]);
});

test("collectGooglePages rejects instead of returning a partial result", async () => {
  await assert.rejects(
    collectGooglePages(async (pageToken) => {
      if (!pageToken) return { items: [1], nextPageToken: "page-2" };
      throw new Error("page failed");
    }),
    /page failed/,
  );
});

test("collectGooglePages rejects a repeated page token", async () => {
  await assert.rejects(
    collectGooglePages(async () => ({ items: [], nextPageToken: "same" })),
    /repeated nextPageToken/,
  );
});
