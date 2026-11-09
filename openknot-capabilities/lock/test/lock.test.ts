import { requireLease } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("a lease must be a positive integer number of milliseconds", () => {
  requireLease(1);
  for (const leaseMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => requireLease(leaseMs), /positive integer/);
  }
});
