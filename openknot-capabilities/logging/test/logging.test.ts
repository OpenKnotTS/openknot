import { consoleLogging, createLogger, parseLogLevel } from "../src/index.ts";
import type { LogRecord, Logging } from "../src/index.ts";
import { logger, logging } from "../src/wire.ts";
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

function recording(): Logging & { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (record) => void records.push(record) };
}

test("records below the level are not written and children add their attributes", () => {
  const sink = recording();
  const log = createLogger(sink, { level: "info", attributes: { service: "roles" } });
  log.debug("hidden");
  log.child({ roleId: "r1" }).warn("renamed", { name: "admin" });
  assert.deepEqual(sink.records, [
    { level: "warn", message: "renamed", attributes: { service: "roles", roleId: "r1", name: "admin" } },
  ]);
  assert.ok(Object.isFrozen(sink.records[0]) && Object.isFrozen(sink.records[0]?.attributes));
});

test("levels are read from configuration, info by default", () => {
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel(" DEBUG "), "debug");
  assert.equal(parseLogLevel("TRACE"), "trace");
  assert.equal(parseLogLevel("fatal"), "fatal");
  assert.throws(() => parseLogLevel("verbose"), /trace, debug, info, warn, error, fatal/);
});

test("a failing implementation never fails the caller and is reported", (t) => {
  const reported = t.mock.method(console, "error", () => {});
  const failure = new Error("disk full");
  const log = createLogger({
    write: () => {
      throw failure;
    },
  });
  assert.doesNotThrow(() => log.error("lost"));
  assert.deepEqual(
    reported.mock.calls.map(({ arguments: [, details] }) => details),
    [{ level: "error", message: "lost", error: failure }],
  );
});

test("the console writes trace without a stack and fatal on stderr", (t) => {
  const debug = t.mock.method(console, "debug", () => {});
  const error = t.mock.method(console, "error", () => {});
  const trace = t.mock.method(console, "trace", () => {});
  const log = createLogger(consoleLogging, { level: "trace" });
  log.trace("detail");
  log.fatal("down");
  assert.match(String(debug.mock.calls[0]?.arguments[0]), / TRACE detail$/);
  assert.match(String(error.mock.calls[0]?.arguments[0]), / FATAL down$/);
  assert.equal(trace.mock.callCount(), 0);
});

test("the console implementation writes one line and passes attributes through", (t) => {
  const info = t.mock.method(console, "info", () => {});
  consoleLogging.write({ level: "info", message: "started", attributes: {} });
  consoleLogging.write({ level: "info", message: "listening", attributes: { port: 3000 } });
  assert.match(String(info.mock.calls[0]?.arguments[0]), /^\d{4}-\d{2}-\d{2}T\S+ INFO started$/);
  assert.equal(info.mock.calls[0]?.arguments.length, 1);
  assert.deepEqual(info.mock.calls[1]?.arguments[1], { port: 3000 });
});

test("logger writes on the console by default, follows LOG_LEVEL and a provided implementation replaces it", async (t) => {
  const debug = t.mock.method(console, "debug", () => {});
  const sink = recording();
  const provided = unit({ provides: logging, factory: () => sink });
  const consoleApp = await runApplication(defineApplication({ modules: [composeModule({ providers: { logger } })] }), {
    env: { LOG_LEVEL: "debug" },
  });
  const providedApp = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { logger, provided } })] }),
    { env: {} },
  );
  try {
    consoleApp.resolve(logger).debug("from console");
    providedApp.resolve(logger).debug("filtered at info");
    providedApp.resolve(logger).info("from plug");
    assert.equal(debug.mock.callCount(), 1);
    assert.deepEqual(
      sink.records.map(({ message }) => message),
      ["from plug"],
    );
  } finally {
    await Promise.all([consoleApp.stop(), providedApp.stop()]);
  }
});

test("with tracing bound, written records carry the active span's ids and filtered ones never ask for them", async () => {
  let asked = 0;
  let active: { readonly traceId: string; readonly spanId: string } | undefined;
  const tracing: Tracing = {
    run: (_span, work) => work(),
    capture: () => undefined,
    bind: (work) => work,
    correlation: () => (asked++, active),
  };
  const sink = recording();
  const provided = unit({ provides: logging, factory: () => sink });
  const traced = unit({ provides: trace, factory: () => tracing });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { logger, provided, traced } })] }),
    { env: {} },
  );
  try {
    const log = app.resolve(logger);
    log.info("outside a span");
    active = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
    log.debug("filtered");
    log.info("inside a span", { spanId: "forged" });
  } finally {
    await app.stop();
  }
  assert.equal(asked, 2);
  assert.deepEqual(
    sink.records.map(({ message, attributes }) => ({ message, attributes })),
    [
      { message: "outside a span", attributes: {} },
      {
        message: "inside a span",
        attributes: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" },
      },
    ],
  );
});

test("an invalid LOG_LEVEL stops the application from starting", async () => {
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { logger } })] }), {
      env: { LOG_LEVEL: "loud" },
    }),
    /LOG_LEVEL/,
  );
});
