import type { InputResult } from "../src/index.ts";
import { command, query, expose, listener, InternalFlowError, InputCancelledError } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { failure, reader, success } from "@openknot-ts/behavior";
import { composeModule, defineApplication, resource, runApplication, unit, plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

test("explicit handler references retain native scoped DI and actor across nested execution", async () => {
  let constructed = 0;
  const session = unit({ lifetime: "scoped", factory: () => ++constructed });
  const read = query<number>()({
    requirements: { session },
    run: (input, ctx) => success({ value: input + ctx.session, execution: ctx.actor, session: ctx.session }),
  });
  const action = command<number>()({
    requirements: { read, session },
    run: async (input, ctx) => {
      const result = await ctx.read(input);
      assert.ok(!result.isError);
      assert.equal(result.value.session, ctx.session);
      assert.equal(result.value.execution, ctx.actor);
      return result;
    },
  });
  const endpoint = expose<number>()({ requirements: { command: action }, run: (input, ctx) => ctx.command(input) });
  const app = await runApplication(defineApplication({ modules: [provideFlow([endpoint])] }));
  try {
    const first = await app.resolve(endpoint)({ input: 4, actor: "alice" });
    assert.equal(first.value, 5);
    assert.equal(first.execution, "alice");
    const second = await app.resolve(endpoint)({ input: 4 });
    assert.equal(second.session, 2);
    assert.notEqual(first.execution, second.execution);
    assert.equal(second.execution, undefined);
    assert.equal(constructed, 2);
    const direct = await app.withScope((scope) => scope.resolve(action)(1));
    assert.ok(!direct.isError && direct.value.session === 3);
  } finally {
    await app.stop();
  }
});

test("gateway failures retain declared errors and contain throws, invalid results and cancellation", async () => {
  const expected = new Error("business"),
    defect = new Error("defect");
  const action = command<string>()({
    run: (mode): InputResult => {
      if (mode === "failure") {
        return failure(expected);
      }
      if (mode === "throw") {
        throw defect;
      }
      if (mode === "invalid") {
        return undefined as unknown as InputResult;
      }
      return success("ok");
    },
  });
  const endpoint = expose<string>()({ requirements: { command: action }, run: (input, ctx) => ctx.command(input) });
  const app = await runApplication(defineApplication({ modules: [provideFlow([endpoint])] }));
  try {
    await app.withScope(async (scope) => {
      const handler = scope.resolve(action);
      assert.deepEqual(await handler("failure"), failure(expected));
      for (const mode of ["throw", "invalid"]) {
        const result = await handler(mode);
        assert.ok(result.isError && InternalFlowError.is(result.error));
      }
      assert.deepEqual(await handler("ok"), success("ok"));
      const invalid = await Reflect.apply(handler, undefined, ["ok", { signal: 42 }]);
      assert.ok(invalid.isError && InternalFlowError.is(invalid.error));
      const controller = new AbortController();
      controller.abort();
      const cancelled = await handler("ok", { signal: controller.signal });
      assert.ok(cancelled.isError && InputCancelledError.is(cancelled.error));
    });
  } finally {
    await app.stop();
  }
});

test("handler dependencies participate in native lifetime and exclusion validation", async () => {
  const dependency = reader<() => number>();
  const action = command({
    requirements: { dependency },
    run: (_, ctx) => success(ctx.dependency()),
  });
  const singleton = unit({ requirements: { command: action }, factory: ({ command }) => command });
  const endpoint = expose({ requirements: { command: action }, run: (_, ctx) => ctx.command() });
  const binding = composeModule({ providers: { binding: plug({ port: dependency, bind: () => () => 1 }) } });
  await assert.rejects(
    runApplication(
      defineApplication({ modules: [provideFlow([endpoint, singleton]).includeOnly([singleton]), binding] }),
    ),
    /shorter lifetime/,
  );
  await assert.rejects(
    // @ts-expect-error Excluding the contract leaves it unbound at compile time as well.
    runApplication(defineApplication({ modules: [provideFlow([endpoint]).exclude([dependency])] })),
    /reader 'dependency' is unavailable or excluded \(expose → command → dependency\)/,
  );
});

test("listener invocations preserve the actor in independent execution contexts shared by nested queries", async () => {
  const read = query({ run: (_, ctx) => success(ctx.actor) });
  const onMessage = listener<string>()({
    requirements: { read },
    run: async (_input, ctx) => {
      const result = await ctx.read();
      if (result.isError) {
        return result;
      }
      assert.equal(result.value, ctx.actor);
      return success(ctx.actor);
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([onMessage])] }));
  try {
    const actor = { subject: "actor" };
    const first = await app.resolve(onMessage)({ input: "one", actor });
    const second = await app.resolve(onMessage)({ input: "two", actor });
    assert.deepEqual(first, actor);
    assert.deepEqual(second, actor);
    assert.equal(first, second);
  } finally {
    await app.stop();
  }
});

test("completed executions abort with one shared reason and leave no listener on the caller's signal", async () => {
  const signals: { root: AbortSignal; nested: AbortSignal; own: AbortSignal }[] = [];
  const own = new AbortController();
  const nested = query({ run: (_, ctx) => success(ctx.signal) });
  const action = command({
    requirements: { nested },
    run: async (_, ctx) => {
      const shared = await ctx.nested();
      const separate = await ctx.nested(undefined, { signal: own.signal });
      assert.ok(!shared.isError && !separate.isError);
      signals.push({ root: ctx.signal, nested: shared.value, own: separate.value });
      return success();
    },
  });
  const endpoint = expose({ handler: action });
  const app = await runApplication(defineApplication({ modules: [provideFlow([endpoint])] }));
  const caller = new AbortController();
  try {
    for (let run = 0; run < 2; run++) {
      await app.resolve(endpoint)({ input: undefined, signal: caller.signal });
    }
    const [first, second] = signals;
    assert.ok(first !== undefined && second !== undefined);
    // Nested work shares its root's signal unless it passes its own, which it then follows until it completes.
    assert.equal(first.nested, first.root);
    assert.notEqual(first.own, first.root);
    for (const signal of [first.root, first.own, second.root]) {
      assert.equal(signal.aborted, true);
      assert.equal((signal.reason as Error).name, "AbortError");
    }
    assert.equal(first.root.reason, second.root.reason);
    assert.equal(first.own.reason, first.root.reason);
    assert.deepEqual(getEventListeners(caller.signal, "abort"), []);
    assert.deepEqual(getEventListeners(own.signal, "abort"), []);
    assert.equal(caller.signal.aborted, false);
  } finally {
    await app.stop();
  }
});

test("a cancelled request stops waiting for its scope resources", { timeout: 2_000 }, async () => {
  const connecting = Promise.withResolvers<void>();
  const session = resource({
    lifetime: "scoped",
    initialize: (_dependencies, { signal }) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        connecting.resolve();
      }),
  });
  let executed = false;
  const action = command({
    requirements: { session },
    run: () => {
      executed = true;
      return success();
    },
  });
  const endpoint = expose({ handler: action });
  const app = await runApplication(defineApplication({ modules: [provideFlow([endpoint])] }));
  try {
    const caller = new AbortController();
    const pending = app.resolve(endpoint)({ input: undefined, signal: caller.signal });
    await connecting.promise;
    caller.abort("client went away");
    await assert.rejects(pending, InputCancelledError.is);
    assert.equal(executed, false);
  } finally {
    await app.stop();
  }
});

test("concurrent root executions keep scopes and cancellation independent", { timeout: 2_000 }, async () => {
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  let acquired = 0;
  const released: number[] = [];
  const session = resource({
    lifetime: "scoped",
    async initialize() {
      const id = ++acquired;
      return {
        value: id,
        release() {
          released.push(id);
        },
      };
    },
  });
  const action = command<number>()({
    requirements: { session },
    run: async (input, ctx) => {
      if (input === 1) {
        entered.resolve();
        await finish.promise;
      }
      ctx.signal.throwIfAborted();
      return success({ session: ctx.session, execution: ctx.actor });
    },
  });
  const endpoint = expose<number>()({ requirements: { command: action }, run: (input, ctx) => ctx.command(input) });
  const app = await runApplication(defineApplication({ modules: [provideFlow([endpoint])] }));
  const controller = new AbortController();
  try {
    const first = app.resolve(endpoint)({ input: 1, signal: controller.signal });
    await entered.promise;
    const second = await app.resolve(endpoint)({ input: 2 });
    assert.equal(second.session, 2);
    assert.deepEqual(released, [2]);
    controller.abort("cancelled first execution");
    finish.resolve();
    await assert.rejects(first, InputCancelledError.is);
    assert.deepEqual(released, [2, 1]);
    assert.equal(acquired, 2);
  } finally {
    finish.resolve();
    await app.stop();
  }
});
