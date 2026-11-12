import type { ErrorReport } from "../src/index.ts";
import { isReported, reportError } from "../src/index.ts";
import { error } from "@openknot-ts/behavior";
import assert from "node:assert/strict";
import { test } from "node:test";

const PaymentDeclined = error("PaymentDeclined");
const OutOfStock = error("OutOfStock");

const report = (failure: unknown, expected: boolean): ErrorReport => ({ error: failure, source: "test", expected });

test("unexpected failures are always reported and expected ones only when selected", () => {
  assert.equal(isReported(report(new Error("crash"), false)), true);
  assert.equal(isReported(report(new Error("crash"), false), [PaymentDeclined]), true);
  assert.equal(isReported(report(PaymentDeclined(), true)), false);
  assert.equal(isReported(report(PaymentDeclined(), true), [PaymentDeclined]), true);
  assert.equal(isReported(report(OutOfStock(), true), [PaymentDeclined]), false);
});

test("a custom kind selects expected failures by any rule", () => {
  const typeErrors = { is: (value: unknown) => value instanceof TypeError };
  assert.equal(isReported(report(new TypeError("bad"), true), [typeErrors]), true);
  assert.equal(isReported(report(new RangeError("bad"), true), [typeErrors]), false);
});

test("a failing reporter never fails the work that reports", (t) => {
  t.mock.method(console, "error", () => undefined);
  assert.doesNotThrow(() =>
    reportError(
      () => {
        throw new Error("reporter down");
      },
      report(new Error("crash"), false),
    ),
  );
});
