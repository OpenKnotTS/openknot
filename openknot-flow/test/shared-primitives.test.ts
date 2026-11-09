import {
  expose,
  guard,
  isWriterBinding,
  listener,
  scheduler,
  standalone as orchestrationStandalone,
  writer,
} from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { standalone, InternalBehaviorError, isReaderBinding, operation, reader, success } from "@openknot-ts/behavior";
import { runApplication, defineApplication, unit, plug, override } from "@openknot-ts/wire";
import { BindPort } from "@openknot-ts/wire/internal/marker";
import assert from "node:assert/strict";
import { test } from "node:test";

const ReaderBindingMarker = Symbol.for("@openknot-ts/behavior/reader-binding");
const WriterBindingMarker = Symbol.for("@openknot-ts/flow/writer-binding");

test("executable ports and guards capture run once while retaining automatic integration and execution contracts", async () => {
  function changingRun<F extends (...args: never[]) => unknown>(run: F) {
    let reads = 0;
    return {
      options: {
        requirements: {},
        get run() {
          reads++;
          if (reads > 1) {
            throw new Error("run was read again");
          }
          return run;
        },
      },
      reads: () => reads,
    };
  }
  const permission = changingRun(() => success());
  const access = guard(permission.options);
  const route = changingRun((input: string) => success(input));
  const port = expose<string>()(Object.assign(route.options, { guards: { access } }));
  const messages = changingRun((input: string) => success(input));
  const onMessage = listener<string>()(messages.options);
  const timers = changingRun(() => success("tick"));
  const tick = scheduler(Object.assign(timers.options, { schedule: { every: { seconds: 1 } } }));
  assert.ok([access, port, onMessage, tick].every(Object.isFrozen));
  const app = await runApplication(defineApplication({ modules: [provideFlow([port, onMessage, tick])] }));
  try {
    assert.deepEqual(await app.resolve(port)({ input: "route", access: undefined }), "route");
    assert.deepEqual(await app.resolve(onMessage)({ input: "message" }), "message");
    assert.deepEqual(await app.resolve(tick)({ trigger: { scheduledAt: 0 } }), "tick");
    await app.withScope(async (scope) => {
      assert.deepEqual(await scope.resolve(access)(), success());
    });
    assert.deepEqual(
      [permission, route, messages, timers].map((factory) => factory.reads()),
      [1, 1, 1, 1],
    );
  } finally {
    await app.stop();
  }
});

test("input safety forwards operation failures with their behavior boundary and original cause", async () => {
  const cause = new Error("reader unavailable");
  const read = operation({
    requirements: {},
    tag: "role.find",
    run: () => {
      throw cause;
    },
  });
  const port = expose({ requirements: { read }, run: (_input, ctx) => ctx.read() });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    await assert.rejects(
      app.resolve(port)({ input: undefined }),
      (error) => InternalBehaviorError.is(error) && error.boundary === "role.find" && error.cause === cause,
    );
  } finally {
    await app.stop();
  }
});

test("shared bindable construction keeps reader/writer identities, signatures and independent bindings", () => {
  const read = reader<(id: string) => string>();
  const write = writer<(id: string) => string>();
  const first = plug({ port: read, bind: () => (id) => `first:${id}` });
  const second = plug({ port: read, bind: () => (id) => `second:${id}` });
  const written = plug({ port: write, bind: () => (id) => `write:${id}` });
  assert.equal(first.port, read);
  assert.equal(second.port, read);
  assert.equal(written.port, write);
  assert.equal(orchestrationStandalone, standalone);
  assert.ok([read, write, first, second, written].every(Object.isFrozen));
  assert.ok(!("run" in read) && !("implementation" in read));
  assert.ok(!("run" in write) && !("implementation" in write));
  assert.equal(isReaderBinding(written), false);
  assert.equal(isWriterBinding(first), false);
  assert.equal(isReaderBinding({ ...written, [ReaderBindingMarker]: true, reader: write }), false);
  assert.equal(isWriterBinding({ ...first, [WriterBindingMarker]: true, writer: read }), false);
  for (const contract of [read, write]) {
    assert.throws(() => Reflect.apply(contract[BindPort], contract, [1]), /must be a function/);
  }
});

test("listener and scheduler integration graphs use exactly the execution requirement snapshot", async () => {
  const original = unit({ factory: () => "original", lifetime: "scoped" });
  const changed = unit({
    factory: () => {
      throw new Error("A requirement getter was evaluated twice");
    },
    lifetime: "scoped",
  });
  function changingRequirements() {
    let reads = 0;
    return {
      requirements: {
        get dependency() {
          reads++;
          return reads === 1 ? original : changed;
        },
      },
      reads: () => reads,
    };
  }
  const messages = changingRequirements();
  const timers = changingRequirements();
  const onMessage = listener({
    requirements: messages.requirements,
    run: (_input, ctx) => success(ctx.dependency),
  });
  const tick = scheduler({
    schedule: { every: { seconds: 1 } },
    requirements: timers.requirements,
    run: (_input, ctx) => success(ctx.dependency),
  });
  assert.equal(messages.reads(), 1);
  assert.equal(timers.reads(), 1);
  assert.ok(Object.isFrozen(onMessage.requirements) && Object.isFrozen(tick.requirements));
  const app = await runApplication(defineApplication({ modules: [provideFlow([onMessage, tick])] }));
  try {
    assert.deepEqual(await app.resolve(onMessage)({ input: undefined }), "original");
    assert.deepEqual(await app.resolve(tick)({ trigger: { scheduledAt: 0 } }), "original");
  } finally {
    await app.stop();
  }
  assert.equal(messages.reads(), 1);
  assert.equal(timers.reads(), 1);
});

test("shared requirements retain the distinct behavior and flow policies", async () => {
  const read = reader<() => string>();
  const requirements = { signal: read };
  const run = operation({
    requirements,
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.signal() } }),
  });
  assert.deepEqual(
    await standalone(run, [override(read, () => "allowed in behavior")])(),
    success({ output: { changeType: "updated" as const, next: "allowed in behavior" } }),
  );
  for (const declare of [
    () => guard({ requirements, run: () => success() }),
    () => expose({ requirements, run: () => success() }),
    () => listener({ requirements, run: () => success() }),
    () => scheduler({ requirements, schedule: { every: { seconds: 1 } }, run: () => success() }),
  ]) {
    assert.throws(declare, /Reserved requirement name: signal/);
  }
  for (const dependency of [
    writer<() => string>(),
    guard({ requirements: {}, run: () => success() }),
    unit({ factory: () => 1 }),
    null,
  ]) {
    assert.throws(
      () =>
        Reflect.apply(operation(), undefined, [
          {
            requirements: { dependency },
            run: () => success({ output: { changeType: "updated" as const, next: 1 } }),
          },
        ]),
      /Invalid operation requirement: dependency/,
    );
  }
});
