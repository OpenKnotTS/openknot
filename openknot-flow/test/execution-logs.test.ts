import { command, expose, query } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import type { LogRecord } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import type { Environment } from "@openknot-ts/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const RoleNotFound = error("RoleNotFound");

function application(env: Environment) {
  const records: LogRecord[] = [];
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const rename = command<string>()({
    tag: "role.rename",
    run: (name) => {
      if (name === "crash") {
        throw new Error("defect");
      }
      return name === "missing" ? failure(RoleNotFound()) : success(name);
    },
  });
  const endpoint = expose({ tag: "roles.rename", handler: rename });
  const definition = defineApplication({
    modules: [provideFlow([endpoint]), composeModule({ providers: { recorded } })],
  });
  return { records, endpoint, start: () => runApplication(definition, { env }) };
}

const summary = ({ level, message, attributes }: LogRecord) => {
  const { durationMs, error: thrown, ...rest } = attributes;
  return {
    level,
    message,
    ...rest,
    ...(durationMs === undefined ? {} : { durationMs: typeof durationMs }),
    ...(thrown === undefined ? {} : { error: ((thrown as Error).cause as Error).message }),
  };
};

test("enabled kinds log their tagged executions at the configured level, with durations when asked", async () => {
  const { records, endpoint, start } = application({
    LOG_LEVEL_COMMAND: "debug",
    LOG_LEVEL_EXPOSE: "warn",
    LOG_DURATION: "true",
  });
  const app = await start();
  try {
    const invoke = app.resolve(endpoint);
    assert.equal(await invoke({ input: "admin" }), "admin");
    await assert.rejects(invoke({ input: "missing" }), RoleNotFound.is);
    await assert.rejects(invoke({ input: "crash" }));
  } finally {
    await app.stop();
  }
  const command = { kind: "command", tag: "role.rename" };
  const exposure = { kind: "expose", tag: "roles.rename" };
  assert.deepEqual(records.map(summary), [
    { level: "debug", message: "command role.rename started", ...command },
    { level: "info", message: "command role.rename succeeded", ...command, durationMs: "number" },
    { level: "debug", message: "command role.rename started", ...command },
    {
      level: "warn",
      message: "command role.rename failed",
      ...command,
      errorType: "RoleNotFound",
      durationMs: "number",
    },
    {
      level: "warn",
      message: "expose roles.rename failed",
      ...exposure,
      errorType: "RoleNotFound",
      durationMs: "number",
    },
    { level: "debug", message: "command role.rename started", ...command },
    {
      level: "error",
      message: "command role.rename failed",
      ...command,
      errorType: "InternalFlowError",
      error: "defect",
      durationMs: "number",
    },
    {
      level: "error",
      message: "expose roles.rename failed",
      ...exposure,
      errorType: "InternalFlowError",
      error: "defect",
      durationMs: "number",
    },
  ]);
});

test("without a kind's variable nothing is logged, and durations are off by default", async () => {
  const silent = application({});
  const app = await silent.start();
  const timed = application({ LOG_LEVEL_EXPOSE: "info" });
  const other = await timed.start();
  try {
    await app.resolve(silent.endpoint)({ input: "admin" });
    await other.resolve(timed.endpoint)({ input: "admin" });
  } finally {
    await Promise.all([app.stop(), other.stop()]);
  }
  assert.deepEqual(silent.records, []);
  assert.deepEqual(timed.records.map(summary), [
    { level: "info", message: "expose roles.rename succeeded", kind: "expose", tag: "roles.rename" },
  ]);
});

test("a viewed exposure's handler and view run as one handler under the exposure's tag", async () => {
  const records: LogRecord[] = [];
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const rename = command<string>()({ tag: "role.rename", run: (name) => success(name) });
  const show = query<string>()({ tag: "role.show", run: (name) => success({ name }) });
  const endpoint = expose({ tag: "roles.rename", handler: rename, view: show });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([endpoint]), composeModule({ providers: { recorded } })] }),
    { env: { LOG_LEVEL_COMMAND: "info", LOG_LEVEL_QUERY: "info" } },
  );
  try {
    assert.deepEqual(await app.resolve(endpoint)({ input: "admin" }), { name: "admin" });
  } finally {
    await app.stop();
  }
  assert.deepEqual(
    records.map(({ message }) => message),
    ["command role.rename succeeded", "query role.show succeeded", "command roles.rename succeeded"],
  );
});

test("invalid execution log settings stop startup, and a tag must be a non-empty string", async () => {
  for (const env of [{ LOG_LEVEL_QUERY: "loud" }, { LOG_DURATION: "yes" }]) {
    await assert.rejects(application(env).start(), new RegExp(Object.keys(env)[0]!));
  }
  assert.equal(query({ tag: "roles.list", run: () => success([]) }).tag, "roles.list");
  assert.equal(Object.hasOwn(query({ run: () => success([]) }), "tag"), false);
  assert.throws(() => query({ tag: " ", run: () => success([]) }), /tag must be a non-empty string/);
});
