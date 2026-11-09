import type { InputInvoker, ListenerRequest, SchedulerRequest } from "../src/index.ts";
import {
  publisher,
  InputCancelledError,
  InputUnavailableError,
  InternalFlowError,
  intervalMilliseconds,
  listener,
  scheduler,
} from "../src/index.ts";
import type {} from "../src/wire.ts";
import { rejection } from "./fixtures/rejection.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { error, failure, operation, reader, success } from "@openknot-ts/behavior";
import { plug, runApplication, defineApplication, composeModule, resource, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

function deferred() {
  return Promise.withResolvers<void>();
}

test("definitions snapshot schedules and requirements and validate their boundaries", () => {
  const every = { minutes: 5 };
  const port = scheduler({ schedule: { every }, requirements: {}, run: () => success() });
  every.minutes = 10;
  assert.deepEqual(port.schedule, { every: { minutes: 5 } });
  assert.equal(port.overlap, "skip");
  assert.equal(intervalMilliseconds({ hours: 1, minutes: 30 }), 5_400_000);
  assert.ok(Object.isFrozen(port));
  assert.throws(() => intervalMilliseconds({ seconds: 0 }), /Invalid interval/);
  assert.throws(() => intervalMilliseconds({ milliseconds: Infinity }), /Invalid interval/);
  assert.throws(
    () =>
      scheduler({
        schedule: { cron: "0 8 * * *", timeZone: "invalid-zone" },
        requirements: {},
        run: () => success(),
      }),
    RangeError,
  );
  assert.throws(() => listener({ requirements: { signal: {} }, run: () => success() }), /Reserved/);
  assert.throws(
    () => Reflect.apply(listener, undefined, [{ requirements: {}, guards: {}, run: () => success() }]),
    /guards/,
  );
  assert.throws(
    () =>
      Reflect.apply(scheduler, undefined, [
        { schedule: { every: { seconds: 1 }, cron: "* * * * *" }, requirements: {}, run: () => success() },
      ]),
    /not both/,
  );
});

test("listeners resolve fresh scoped dependencies, preserve metadata and release every scope", async () => {
  let nextId = 0;
  const released: number[] = [];
  const session = resource({
    async initialize() {
      const id = ++nextId;
      return {
        value: id,
        release() {
          released.push(id);
        },
      };
    },
    lifetime: "scoped",
  });
  const port = listener<string>()({
    requirements: { session },
    run: (input, ctx) => {
      assert.equal(ctx.signal.aborted, false);
      return success({ input, session: ctx.session, id: ctx.trigger.messageId, attempt: ctx.trigger.attempt });
    },
  });
  let invoke: InputInvoker<typeof port> | undefined;
  let sourceSignal: AbortSignal | undefined;
  let cleanup = 0;
  const binding = plug({
    port,
    requirements: {},
    bind: (ctx) => {
      invoke = ctx.invoke;
      sourceSignal = ctx.signal;
      return {
        release() {
          cleanup++;
        },
      };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] }));
  assert.ok(invoke);
  const first = await invoke({ input: "first", trigger: { messageId: "m1", attempt: 2 } });
  const second = await invoke({ input: "second" });
  assert.deepEqual(first, { input: "first", session: 1, id: "m1", attempt: 2 });
  assert.equal(second.session, 2);
  assert.deepEqual(released, [1, 2]);
  await app.stop();
  await app.stop();
  assert.equal(cleanup, 1);
  assert.equal(sourceSignal?.aborted, true);
  await assert.rejects(invoke({ input: "late" }), InputUnavailableError.is);
  assert.equal(nextId, 2);
});

test("scheduler skip is shared across adapters for the same port and does not acquire another scope", async () => {
  const entered = deferred();
  const finish = deferred();
  let resolutions = 0;
  const dependency = unit({ factory: () => ++resolutions, lifetime: "scoped" });
  const scheduledAt = Date.parse("2026-01-01T00:00:00Z");
  const port = scheduler({
    schedule: { every: { seconds: 5 } },
    requirements: { dependency },
    run: async (_input, ctx) => {
      assert.equal(ctx.trigger.scheduledAt, scheduledAt);
      entered.resolve();
      await finish.promise;
      return success(ctx.dependency);
    },
  });
  const calls: InputInvoker<typeof port>[] = [];
  const first = plug({
    port,
    requirements: {},
    bind: ({ invoke }) => {
      calls.push(invoke);
      return { release() {} };
    },
  });
  const second = plug({
    port,
    requirements: {},
    bind: ({ invoke }) => {
      calls.push(invoke);
      return { release() {} };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { first, second } })] }));
  const call = calls[0];
  const other = calls[1];
  assert.ok(call && other);
  const running = call({ trigger: { scheduledAt } });
  await entered.promise;
  assert.deepEqual(await other({ trigger: { scheduledAt } }), { status: "skipped", reason: "overlap" });
  assert.equal(resolutions, 1);
  finish.resolve();
  assert.equal(await running, 1);
  await app.stop();
});

test("overlap allow admits concurrent scheduler invocations", async () => {
  const entered = deferred();
  const finish = deferred();
  let running = 0;
  const port = scheduler({
    schedule: { cron: "0 8 * * *", timeZone: "Europe/Athens" },
    overlap: "allow",
    requirements: {},
    run: async () => {
      running++;
      if (running === 2) {
        entered.resolve();
      }
      await finish.promise;
      return success();
    },
  });
  const configuration = defineApplication({ modules: [composeModule({ providers: { port } })] });
  const app = await runApplication(configuration);
  const other = await runApplication(configuration);
  const request = { trigger: { scheduledAt: Date.now() } };
  const first = app.resolve(port)(request);
  const second = app.resolve(port)(request);
  await entered.promise;
  finish.resolve();
  await Promise.all([first, second, other.resolve(port)(request)]);
  await Promise.all([app.stop(), other.stop()]);
  assert.equal(running, 3);
});

test("expected failures retain identity; throws, invalid outcomes and invalid metadata become technical failures", async () => {
  const BusinessError = error("BusinessError");
  type BusinessError = ReturnType<typeof BusinessError>;
  const expected = BusinessError("declined");
  const defect = new Error("database failed");
  const port = listener<string>()({
    requirements: {},
    run: (mode): Outcome<void, BusinessError> => {
      if (mode === "expected") {
        return failure(expected);
      }
      if (mode === "throw") {
        throw defect;
      }
      if (mode === "invalid") {
        return 1 as unknown as Outcome<void, BusinessError>;
      }
      return success();
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { port } })] }));
  const invoke = app.resolve(port);
  await assert.rejects(invoke({ input: "expected" }), (error) => error === expected);
  await assert.rejects(invoke({ input: "throw" }), (error) => InternalFlowError.is(error) && error.cause === defect);
  await assert.rejects(invoke({ input: "invalid" }), InternalFlowError.is);
  await assert.rejects(invoke({ input: "ok", trigger: { attempt: 0 } }), InternalFlowError.is);
  await app.stop();
});

test("shutdown stops intake then drains scopes before releasing shared resources", async () => {
  const events: string[] = [];
  const entered = deferred();
  const finish = deferred();
  const backend = resource({
    async initialize() {
      events.push("backend:open");
      return {
        value: 42,
        release() {
          events.push("backend:release");
        },
      };
    },
  });
  const session = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          events.push("session:release");
        },
      };
    },
    lifetime: "scoped",
  });
  const port = listener({
    requirements: { backend, session },
    run: async () => {
      entered.resolve();
      await finish.promise;
      events.push("execute:done");
      return success();
    },
  });
  let invoke: InputInvoker<typeof port> | undefined;
  const binding = plug({
    port,
    requirements: { backend },
    bind: (ctx) => {
      assert.equal(ctx.backend, 42);
      events.push("bind");
      invoke = ctx.invoke;
      return {
        release() {
          events.push("source:release");
        },
      };
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { binding } })],
    }),
  );
  assert.ok(invoke);
  const work = invoke({ input: undefined });
  await entered.promise;
  const stop = app.stop();
  assert.equal(stop, app.stop());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["backend:open", "bind", "source:release"]);
  finish.resolve();
  await work;
  await stop;
  assert.deepEqual(events, [
    "backend:open",
    "bind",
    "source:release",
    "execute:done",
    "session:release",
    "backend:release",
  ]);
});

test("ordered source teardown drains a listener's downstream event before stopping its consumer", async () => {
  const entered = deferred(),
    finish = deferred(),
    releasing = deferred();
  const events: string[] = [];
  const backend = resource({
    async initialize() {
      return {
        value: {},
        release() {
          events.push("backend:release");
        },
      };
    },
  });
  const next = listener<number>()({
    requirements: { backend },
    run: (value) => {
      events.push(`next:${value}`);
      return success();
    },
  });
  const nextPublisher = publisher<number>();
  const first = listener({
    requirements: { nextPublisher },
    run: async (_input, ctx) => {
      entered.resolve();
      await finish.promise;
      await ctx.nextPublisher.publish(42, { signal: ctx.signal });
      events.push("first:done");
      return success();
    },
  });
  let invokeNext: InputInvoker<typeof next> | undefined, invokeFirst: InputInvoker<typeof first> | undefined;
  let pending: ReturnType<InputInvoker<typeof first>> | undefined;
  const downstream = plug({
    port: next,
    bind: ({ invoke }) => {
      invokeNext = invoke;
      return {
        release() {
          events.push("downstream:stop");
        },
      };
    },
  });
  const publishing = plug({
    port: nextPublisher,
    bind: () => async (input, options) => {
      assert.ok(invokeNext);
      await invokeNext({ input, ...options });
    },
  });
  const upstream = plug({
    port: first,
    bind: ({ invoke }) => {
      invokeFirst = invoke;
      return {
        async release() {
          events.push("upstream:stop");
          releasing.resolve();
          await pending;
        },
      };
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { downstream, upstream, publishing } })],
    }),
  );
  const directNext = app.resolve(next);
  try {
    assert.ok(invokeFirst);
    pending = invokeFirst({ input: undefined });
    await entered.promise;
    const stopping = app.stop();
    await releasing.promise;
    // While the intake drains, it still admits invocations, a held invoker's too; a released source admits none.
    await directNext({ input: 99 });
    await assert.rejects(invokeFirst({ input: undefined }), InputUnavailableError.is);
    finish.resolve();
    assert.equal(await pending, undefined);
    await stopping;
    assert.deepEqual(events, [
      "upstream:stop",
      "next:99",
      "next:42",
      "first:done",
      "downstream:stop",
      "backend:release",
    ]);
    assert.ok(invokeNext);
    await assert.rejects(invokeNext({ input: 100 }), InputUnavailableError.is);
    await assert.rejects(directNext({ input: 101 }), InputUnavailableError.is);
  } finally {
    finish.resolve();
    await app.stop();
  }
});

test("eager delivery during bind can complete without deadlocking readiness", async () => {
  let calls = 0;
  const port = listener<number>()({
    requirements: {},
    run: (value) => {
      calls++;
      return success(value);
    },
  });
  const binding = plug({
    port,
    requirements: {},
    bind: async ({ invoke }) => {
      assert.equal(await invoke({ input: 42 }), 42);
      return { release() {} };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] }));
  assert.equal(calls, 1);
  await app.stop();
});

test("startup failure aborts the failing source and releases all previously bound sources", async () => {
  const events: string[] = [];
  const failureToStart = new Error("cannot subscribe");
  const failureToStop = new Error("cannot release");
  const port = listener({ requirements: {}, run: () => success() });
  let failedSignal: AbortSignal | undefined;
  const first = plug({
    port,
    requirements: {},
    bind: () => ({
      release() {
        events.push("first");
      },
    }),
  });
  const second = plug({
    port,
    requirements: {},
    bind: () => ({
      release() {
        events.push("second");
        throw failureToStop;
      },
    }),
  });
  const third = plug({
    port,
    requirements: {},
    bind: ({ signal }) => {
      failedSignal = signal;
      throw failureToStart;
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { first, second, third } })] })),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failureToStart, failureToStop]);
      return true;
    },
  );
  assert.deepEqual(events, ["second", "first"]);
  assert.equal(failedSignal?.aborted, true);
});

test("selection, dependency-only modules and exclusions retain activation semantics", async () => {
  const started: string[] = [];
  const port = listener({ requirements: {}, run: () => success() });
  const first = plug({
    port,
    requirements: {},
    bind: () => {
      started.push("first");
      return { release() {} };
    },
  });
  const second = plug({
    port,
    requirements: {},
    bind: () => {
      started.push("second");
      return { release() {} };
    },
  });
  const selected = composeModule({ providers: { first, second } }).includeOnly([first]);
  const app = await runApplication(defineApplication({ modules: [selected] }));
  assert.deepEqual(started, ["first"]);
  await app.stop();
  const root = composeModule({ providers: {} });
  const dormant = await runApplication(
    defineApplication({ modules: composeModule({ providers: { second } }).requiredBy(root) }),
  );
  await dormant.stop();
  assert.deepEqual(started, ["first"]);
  const excluded = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { first } }).exclude([first])] }),
  );
  await excluded.stop();
  assert.deepEqual(started, ["first"]);
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { first, port } }).exclude([port])] })),
    /unavailable|excluded/,
  );
});

test("plug dependencies enforce singleton lifetime while execution dependencies may be scoped", async () => {
  const scoped = unit({ factory: () => 42, lifetime: "scoped" });
  const port = listener({ requirements: { scoped }, run: (_input, ctx) => success(ctx.scoped) });
  const binding = plug({ port, requirements: { scoped }, bind: () => ({ release() {} }) });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] })),
    /shorter lifetime/,
  );
});

test("cancellation is per invocation and does not release resources while work is still running", async () => {
  const entered = deferred();
  const port = listener({
    requirements: {},
    run: async (_input, ctx) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) =>
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }),
      );
      return success();
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { port } })] }));
  const control = new AbortController();
  const call = app.resolve(port)({ input: undefined, signal: control.signal });
  await entered.promise;
  control.abort(new Error("client cancelled"));
  await assert.rejects(call, InputCancelledError.is);
  await assert.rejects(app.resolve(port)({ input: undefined, signal: control.signal }), InputCancelledError.is);
  await app.stop();
});

test("invalid scheduler timestamps do not execute business behavior and malformed handles fail startup", async () => {
  let executions = 0;
  const port = scheduler({
    schedule: { every: { milliseconds: 1 } },
    requirements: {},
    run: () => {
      executions++;
      return success();
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { port } })] }));
  // Not points in time: not a number, and numbers beyond what a Date represents.
  for (const scheduledAt of [NaN, Infinity, 8.64e15 + 1, new Date(0) as never]) {
    const request: SchedulerRequest = { trigger: { scheduledAt } };
    await assert.rejects(app.resolve(port)(request), InternalFlowError.is);
  }
  assert.equal(executions, 0);
  await app.stop();
  const invalid = Reflect.apply(plug, undefined, [
    { port, requirements: {}, bind: () => () => undefined },
  ]) as ReturnType<typeof plug>;
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { invalid } })] })),
    /release/,
  );
});

// Retain a public request annotation as a regression check for declaration output.
const typedRequest: ListenerRequest<number> = { input: 1 };
void typedRequest;

test("default overlap gates are isolated between application instances", async () => {
  const entered = deferred();
  const finish = deferred();
  let executions = 0;
  const port = scheduler({
    schedule: { every: { seconds: 1 } },
    requirements: {},
    run: async () => {
      executions++;
      if (executions === 2) {
        entered.resolve();
      }
      await finish.promise;
      return success();
    },
  });
  const configuration = defineApplication({ modules: [composeModule({ providers: { port } })] });
  const first = await runApplication(configuration);
  const second = await runApplication(configuration);
  const request = { trigger: { scheduledAt: Date.now() } };
  const work = [first.resolve(port)(request), second.resolve(port)(request)];
  await entered.promise;
  assert.equal(executions, 2);
  assert.deepEqual(await first.resolve(port)(request), { status: "skipped", reason: "overlap" });
  finish.resolve();
  await Promise.all(work);
  await Promise.all([first.stop(), second.stop()]);
});

test("behavior operations and readers resolve through the same execution scope", async () => {
  const findRole = reader<(id: string) => Promise<string>>();
  const binding = plug({ port: findRole, bind: () => (id) => Promise.resolve(`role:${id}`) });
  const loadRole = operation<string>()({
    requirements: { findRole },
    run: async (id, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.findRole(id) } }),
  });
  const port = listener<string>()({
    requirements: { loadRole, findRole },
    run: async (id, ctx) => {
      const role = await ctx.loadRole(id);
      assert.equal(await ctx.findRole(id), `role:${id}`);
      return role;
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { binding, port } })],
    }),
  );
  assert.deepEqual(await app.resolve(port)({ input: "r1" }), {
    output: { changeType: "updated" as const, next: "role:r1" },
  });
  await app.stop();
});

test("scope initialization and release failures reject as technical failures with their causes", async () => {
  const initializationError = new Error("session failed to open");
  const cleanupError = new Error("session failed to close");
  const expected = new Error("business failure");
  const broken = resource({
    initialize() {
      return Promise.reject(initializationError);
    },
    lifetime: "scoped",
  });
  const cleanup = resource({
    initialize() {
      return Promise.resolve({
        value: 1,
        release() {
          throw cleanupError;
        },
      });
    },
    lifetime: "scoped",
  });
  // Each listener needs its session, so the scope it executes in acquires it.
  const opening = listener({ requirements: { broken }, run: () => failure(expected) });
  const closing = listener({ requirements: { cleanup }, run: () => failure(expected) });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { opening } })] }));
  const failedToOpen = await rejection(app.resolve(opening)({ input: undefined }));
  assert.ok(InternalFlowError.is(failedToOpen) && failedToOpen.cause === initializationError);
  await app.stop();
  const other = await runApplication(defineApplication({ modules: [composeModule({ providers: { closing } })] }));
  const failedToClose = await rejection(other.resolve(closing)({ input: undefined }));
  assert.ok(InternalFlowError.is(failedToClose) && failedToClose.cause instanceof AggregateError);
  assert.equal(failedToClose.cause.errors[0], expected);
  const cleanupAggregate: unknown = failedToClose.cause.errors[1];
  assert.ok(cleanupAggregate instanceof AggregateError);
  assert.equal(cleanupAggregate.errors[0], cleanupError);
  await other.stop();
});

test("malformed invocation requests reject with technical failures", async () => {
  const port = listener({ requirements: {}, run: () => success() });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { port } })] }));
  const invoke = app.resolve(port);
  const invalidRequests: readonly unknown[] = [
    null,
    undefined,
    { input: 1, signal: {} },
    {
      get signal() {
        throw new Error("getter failed");
      },
    },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(Reflect.apply(invoke, undefined, [request]), InternalFlowError.is);
  }
  await app.stop();
});
