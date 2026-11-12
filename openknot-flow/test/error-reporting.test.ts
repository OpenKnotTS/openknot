import {
  broadcast,
  command,
  expose,
  guard,
  InputCancelledError,
  InputUnavailableError,
  InternalFlowError,
  listener,
} from "../src/index.ts";
import type { InputInvoker } from "../src/index.ts";
import type {} from "../src/wire.ts";
import { rejection } from "./fixtures/rejection.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import type { LogRecord } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const PaymentDeclined = error("PaymentDeclined");

function recording() {
  const reports: ErrorReport[] = [];
  return {
    reports,
    binding: unit({ provides: errorReporter, factory: () => (report: ErrorReport) => reports.push(report) }),
  };
}

test("an input's unexpected failure is reported once, where the input ends, with its port", async () => {
  const cause = new Error("disk full");
  const inner = command<number>()({
    requirements: {},
    run: async () => {
      throw cause;
    },
  });
  const port = listener<number>()({ requirements: { inner }, run: (value, ctx) => ctx.inner(value) });
  let invoke: InputInvoker<typeof port> | undefined;
  const source = plug({
    port,
    requirements: {},
    bind: (ctx) => {
      invoke = ctx.invoke;
      return { release() {} };
    },
  });
  const { reports, binding } = recording();
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { source, binding } })] }));
  try {
    assert.ok(invoke);
    const rejected = await rejection(invoke({ input: 1 }));
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.equal(report?.error, rejected);
    assert.ok(InternalFlowError.is(report?.error));
    assert.equal(report?.error.cause, cause);
    assert.equal(report?.source, "openknot.listener");
    assert.equal(report?.reference, port);
    assert.equal(report?.expected, false);
  } finally {
    await app.stop();
  }
});

test("an authored failure is reported as expected and a cancelled invocation is not reported", async () => {
  const allow = guard({ requirements: {}, run: () => success() });
  const port = expose<string>()({
    requirements: {},
    guards: { allow },
    run: async (input, ctx) => {
      if (input === "wait") {
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      }
      return failure(PaymentDeclined());
    },
  });
  let invoke: InputInvoker<typeof port> | undefined;
  const source = plug({
    port,
    requirements: {},
    bind: (ctx) => {
      invoke = ctx.invoke;
      return { release() {} };
    },
  });
  const { reports, binding } = recording();
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { source, binding } })] }));
  try {
    assert.ok(invoke);
    await rejection(invoke({ input: "pay" }));
    assert.deepEqual(
      reports.map((report) => [report.source, report.expected, PaymentDeclined.is(report.error)]),
      [["openknot.expose", true, true]],
    );

    const controller = new AbortController();
    const cancelled = rejection(invoke({ input: "wait", signal: controller.signal }));
    controller.abort(new Error("client left"));
    assert.ok(InputCancelledError.is(await cancelled));
    assert.equal(reports.length, 1);
  } finally {
    await app.stop();
  }
});

test("a delivery after its source was released is reported as an expected refusal", async () => {
  const port = listener<number>()({ requirements: {}, run: () => failure(PaymentDeclined()) });
  let invoke: InputInvoker<typeof port> | undefined;
  const source = plug({
    port,
    requirements: {},
    bind: (ctx) => {
      invoke = ctx.invoke;
      return { release() {} };
    },
  });
  const { reports, binding } = recording();
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { source, binding } })] }));
  await app.stop();
  assert.ok(invoke);
  assert.ok(InputUnavailableError.is(await rejection(invoke({ input: 1 }))));
  assert.deepEqual(
    reports.map((report) => [report.source, report.expected, InputUnavailableError.is(report.error)]),
    [["openknot.listener", true, true]],
  );
});

test("a failed subscription admission is reported once with its port", async () => {
  const allow = guard({ requirements: {}, run: () => success() });
  const feed = broadcast<string>()({ guards: { allow } });
  const native = plug({
    port: feed,
    bind: () => ({
      publish: () => undefined,
      subscribe: () => {
        throw new Error("broker down");
      },
    }),
  });
  const { reports, binding } = recording();
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { feed, native, binding } })] }),
  );
  try {
    assert.ok(InternalFlowError.is(await rejection(app.resolve(feed).subscribe({ input: undefined }))));
    assert.deepEqual(
      reports.map((report) => [report.source, report.expected, report.reference === feed]),
      [["openknot.subscribe", false, true]],
    );
  } finally {
    await app.stop();
  }
});

test("a subscription refused before its admission is logged and reported once", async () => {
  const feed = broadcast<string>()({});
  const native = plug({
    port: feed,
    bind: () => ({
      publish: () => undefined,
      subscribe: () => {
        throw new Error("no admission runs");
      },
    }),
  });
  const records: LogRecord[] = [];
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const { reports, binding } = recording();
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { feed, native, binding, recorded } })] }),
    { env: { LOG_LEVEL_SUBSCRIBE: "warn" } },
  );
  const subscriptions = app.resolve(feed);
  await app.stop();
  assert.ok(InputUnavailableError.is(await rejection(subscriptions.subscribe({ input: undefined }))));
  assert.deepEqual(
    records.map((record) => [record.level, record.message]),
    [["warn", "subscribe not admitted"]],
  );
  assert.deepEqual(
    reports.map((report) => [report.source, report.expected]),
    [["openknot.subscribe", true]],
  );
});
