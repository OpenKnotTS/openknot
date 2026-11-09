import { asCacheResult, completed, empty, isCacheResult, unsupported } from "../src/result.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("asCacheResult maps undefined to a miss, wraps a value and keeps a result", () => {
  assert.equal(asCacheResult(undefined), empty());
  assert.deepEqual(asCacheResult(1), completed(1));
  const result = completed(1);
  assert.equal(asCacheResult(result), result);
  assert.equal(asCacheResult(unsupported()), unsupported());
});

test("only results a cache created count as results", () => {
  assert.equal(isCacheResult(completed(null)), true);
  assert.equal(isCacheResult({ kind: "empty" }), false);
});
