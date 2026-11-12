import type { ErrorReport } from "../src/index.ts";
import { isReported } from "../src/index.ts";
import { errorReporter, errorReports, unattendedFailures } from "../src/wire.ts";
import { error } from "@openknot-ts/behavior";
import type { LogRecord } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
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

test("a failing reporter never fails the work that reports, and its failure is logged", async () => {
  const records: LogRecord[] = [];
  const crash = new Error("crash");
  const down = new Error("reporter down");
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const reporter = unit({
    provides: errorReporter,
    factory: () => () => {
      throw down;
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { reports: errorReports, recorded, reporter } })] }),
    { env: {} },
  );
  try {
    assert.doesNotThrow(() => app.resolve(errorReports)(report(crash, false)));
  } finally {
    await app.stop();
  }
  assert.deepEqual(
    records.map((record) => [record.level, record.message, record.attributes]),
    [["error", "openknot.error-reporting failed", { error: down, reported: crash }]],
  );
});

test("an unattended failure is always logged, and reported as unexpected once a reporter is bound", async () => {
  const failure = new Error("connection lost");
  const attributes = { "openknot.cache.name": "roles" };
  const run = async (withReporter: boolean) => {
    const records: LogRecord[] = [];
    const reports: ErrorReport[] = [];
    const recorded = unit({
      provides: logging,
      factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
    });
    const reporter = unit({ provides: errorReporter, factory: () => (each: ErrorReport) => void reports.push(each) });
    const app = await runApplication(
      defineApplication({
        modules: [
          composeModule({
            providers: withReporter
              ? { failures: unattendedFailures, recorded, reporter }
              : { failures: unattendedFailures, recorded },
          }),
        ],
      }),
      { env: {} },
    );
    try {
      app.resolve(unattendedFailures)({ error: failure, source: "openknot.cache", attributes });
    } finally {
      await app.stop();
    }
    return { records, reports };
  };
  const logged = [["error", "openknot.cache failed", { ...attributes, error: failure }]];
  const alone = await run(false);
  assert.deepEqual(
    alone.records.map((record) => [record.level, record.message, record.attributes]),
    logged,
  );
  const reported = await run(true);
  assert.deepEqual(
    reported.records.map((record) => [record.level, record.message, record.attributes]),
    logged,
  );
  assert.deepEqual(reported.reports, [{ error: failure, source: "openknot.cache", expected: false, attributes }]);
});
