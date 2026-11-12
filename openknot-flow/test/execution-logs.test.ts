import type { InputInvoker } from "../src/index.ts";
import {
  command,
  expose,
  InputUnavailableError,
  InternalFlowError,
  listener,
  PostCommitError,
  query,
} from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import type { LogRecord } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import type { Environment } from "@openknot-ts/wire";
import {
  composeModule,
  defineApplication,
  plug,
  providePlugs,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
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

test("by default only an input's defects are written, `off` silences a kind, and durations are off", async () => {
  const defaults = application({});
  const silenced = application({ LOG_LEVEL_EXPOSE: "off" });
  const timed = application({ LOG_LEVEL_EXPOSE: "info" });
  const apps = await Promise.all([defaults.start(), silenced.start(), timed.start()]);
  try {
    for (const [app, { endpoint }] of [
      [apps[0], defaults],
      [apps[1], silenced],
    ] as const) {
      await app.resolve(endpoint)({ input: "admin" });
      await assert.rejects(app.resolve(endpoint)({ input: "missing" }), RoleNotFound.is);
      await assert.rejects(app.resolve(endpoint)({ input: "crash" }));
    }
    await apps[2].resolve(timed.endpoint)({ input: "admin" });
  } finally {
    await Promise.all(apps.map((app) => app.stop()));
  }
  assert.deepEqual(defaults.records.map(summary), [
    {
      level: "error",
      message: "expose roles.rename failed",
      kind: "expose",
      tag: "roles.rename",
      errorType: "InternalFlowError",
      error: "defect",
    },
  ]);
  assert.deepEqual(silenced.records, []);
  assert.deepEqual(timed.records.map(summary), [
    { level: "info", message: "expose roles.rename succeeded", kind: "expose", tag: "roles.rename" },
  ]);
});

test("by default a listener writes every failure, since no caller receives it", async () => {
  const records: LogRecord[] = [];
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const audit = listener<string>()({
    tag: "roles.audit",
    run: (name) => (name === "missing" ? failure(RoleNotFound()) : success(name)),
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([audit]), composeModule({ providers: { recorded } })] }),
    { env: {} },
  );
  try {
    await app.resolve(audit)({ input: "admin" });
    await assert.rejects(app.resolve(audit)({ input: "missing" }), RoleNotFound.is);
  } finally {
    await app.stop();
  }
  assert.deepEqual(records.map(summary), [
    {
      level: "warn",
      message: "listener roles.audit failed",
      kind: "listener",
      tag: "roles.audit",
      errorType: "RoleNotFound",
    },
  ]);
});

test("an input logs every request it refuses before any execution, and an invocation nobody awaits is never unhandled", async () => {
  const records: LogRecord[] = [];
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const audit = listener<string>()({ tag: "roles.audit", run: (name) => success(name) });
  const sources: InputInvoker<typeof audit>[] = [];
  const source = plug({ port: audit, bind: ({ invoke }) => (sources.push(invoke), { release() {} }) });
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([audit]), providePlugs([source]), composeModule({ providers: { recorded } })],
    }),
    { env: {} },
  );
  const invoke = app.resolve(audit);
  await assert.rejects(invoke({ input: "admin", trigger: { messageId: 5 } } as never), InternalFlowError.is);
  await app.stop();
  // The test runner fails on an unhandled rejection, so these unawaited calls also prove they are handled.
  void invoke({ input: "late" });
  void sources[0]!({ input: "late" });
  await assert.rejects(invoke({ input: "late" }), InputUnavailableError.is);
  await assert.rejects(sources[0]!({ input: "late" }), InputUnavailableError.is);
  const identity = { kind: "listener", tag: "roles.audit" };
  const refused = { level: "warn", message: "listener roles.audit not admitted", ...identity };
  assert.deepEqual(records.map(summary), [
    {
      level: "error",
      message: "listener roles.audit failed",
      ...identity,
      errorType: "InternalFlowError",
      error: "Invalid messageId",
    },
    ...Array.from({ length: 4 }, () => ({ ...refused, errorType: "InputUnavailableError" })),
  ]);
});

test("by default a defect after an exposure succeeded, as its scope failing to release, is written with the error", async () => {
  const records: LogRecord[] = [];
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const session = resource({
    lifetime: "scoped",
    initialize: async () => ({
      value: {},
      release() {
        throw new Error("connection release failed");
      },
    }),
  });
  const change = command<boolean>()({ requirements: { session }, run: () => success() });
  const api = expose({ tag: "roles.change", handler: change });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([api]), composeModule({ providers: { recorded } })] }),
    { env: {} },
  );
  try {
    await assert.rejects(app.resolve(api)({ input: true }), PostCommitError.is);
  } finally {
    await app.stop();
  }
  assert.deepEqual(records.map(summary), [
    {
      level: "error",
      message: "expose roles.change failed",
      kind: "expose",
      tag: "roles.change",
      errorType: "PostCommitError",
      error: "Scope cleanup failed.",
    },
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
  for (const env of [{ LOG_LEVEL_QUERY: "loud" }, { LOG_LEVEL_EXPOSE: "none" }, { LOG_DURATION: "yes" }]) {
    await assert.rejects(application(env).start(), new RegExp(Object.keys(env)[0]!));
  }
  assert.equal(query({ tag: "roles.list", run: () => success([]) }).tag, "roles.list");
  assert.equal(Object.hasOwn(query({ run: () => success([]) }), "tag"), false);
  assert.throws(() => query({ tag: " ", run: () => success([]) }), /tag must be a non-empty string/);
});
