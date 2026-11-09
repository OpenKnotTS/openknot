import type { GuardResult } from "../src/index.ts";
import { command, expose, guard, InputCancelledError, InternalFlowError } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { rejection } from "./fixtures/rejection.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import { runApplication, defineApplication, composeModule, override, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const Forbidden = error("Forbidden");
type Forbidden = ReturnType<typeof Forbidden>;

test("guards auto-integrate as scoped dependencies and share their executor with consumers", async () => {
  let constructed = 0;
  const sessions: number[] = [];
  const session = unit({ factory: () => ({ id: ++constructed }), lifetime: "scoped" });
  const access = guard({
    requirements: { session },
    run: (_input, ctx) => {
      sessions.push(ctx.session.id);
      return success();
    },
  });
  const consumer = unit({ requirements: { access }, factory: ({ access }) => access, lifetime: "scoped" });
  const port = expose({
    requirements: { consumer },
    guards: { access },
    run: (_input, ctx) => {
      return ctx.consumer();
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  let previous: unknown;
  try {
    assert.equal(constructed, 0);
    assert.throws(() => app.resolve(access), /withScope/);
    for (let index = 0; index < 2; index++) {
      await app.withScope(async (scope) => {
        const check = scope.resolve(access);
        assert.equal(check, scope.resolve(access));
        assert.equal(check, scope.resolve(consumer));
        assert.notEqual(check, previous);
        previous = check;
        assert.deepEqual(await check(), success());
      });
    }
    assert.deepEqual(await app.resolve(port)({ input: undefined, access: undefined }), undefined);
    assert.deepEqual(sessions, [1, 2, 3, 3]);
    assert.equal(constructed, 3);
  } finally {
    await app.stop();
  }
});

test("replacing a guard changes exposure execution and uses only the replacement's dependencies", async () => {
  const events: string[] = [];
  const unused = unit({
    factory: () => {
      throw new Error("original dependency must remain unused");
    },
    lifetime: "scoped",
  });
  const access = guard<boolean>()({
    requirements: { unused },
    run: (_allowed) => {
      events.push("original");
      return failure(Forbidden("original denied"));
    },
  });
  const session = unit({
    factory: () => {
      events.push("session");
      return "replacement";
    },
    lifetime: "scoped",
  });
  const denial = failure(Forbidden("replacement denied"));
  const replacement = guard<boolean>()({
    requirements: { session },
    run: (allowed, ctx) => {
      events.push(ctx.session);
      return allowed ? success() : denial;
    },
  });
  const port = expose({
    requirements: {},
    guards: { access },
    run: () => {
      events.push("execute");
      return success();
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([port]).exclude([unused]),
        composeModule({
          providers: {
            selection: unit({
              provides: access,
              lifetime: "scoped",
              requirements: { replacement },
              factory: ({ replacement }) => replacement,
            }),
          },
        }),
      ],
    }),
  );
  try {
    assert.deepEqual(await app.resolve(port)({ input: undefined, access: true }), undefined);
    assert.equal(await rejection(app.resolve(port)({ input: undefined, access: false })), denial.error);
    assert.deepEqual(events, ["session", "replacement", "execute", "session", "replacement"]);
  } finally {
    await app.stop();
  }
});

test("guard overrides are application-local and skip the original guard's construction", async () => {
  let constructions = 0;
  const session = unit({
    factory: () => {
      constructions++;
      return false;
    },
    lifetime: "scoped",
  });
  const denial = failure(Forbidden("original denied"));
  const access = guard<string>()({
    requirements: { session },
    run: (_input, ctx) => (ctx.session ? success() : denial),
  });
  const port = expose({ requirements: {}, guards: { access }, run: () => success("executed") });
  const definition = defineApplication({ modules: [provideFlow([port])] });
  const signals: AbortSignal[] = [];
  const app = await runApplication(definition, {
    overrides: [
      override(access, (input, options) => {
        assert.equal(input, "actor");
        assert.ok(options?.signal);
        signals.push(options.signal);
        return Promise.resolve(success());
      }),
    ],
  });
  const other = await runApplication(definition);
  try {
    assert.deepEqual(await app.resolve(port)({ input: undefined, access: "actor" }), "executed");
    assert.equal(constructions, 0);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(await rejection(other.resolve(port)({ input: undefined, access: "actor" })), denial.error);
    assert.equal(constructions, 1);
  } finally {
    await Promise.all([app.stop(), other.stop()]);
  }
});

test("overridden guards use the same result validation and fail before business dependencies resolve", async () => {
  let executions = 0;
  let constructions = 0;
  let result: unknown;
  const access = guard({ requirements: {}, run: (): GuardResult => success() });
  const dependency = unit({
    factory: () => {
      constructions++;
      return true;
    },
    lifetime: "scoped",
  });
  const port = expose({
    requirements: { dependency },
    guards: { access },
    run: () => {
      executions++;
      return success();
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }), {
    overrides: [override(access, () => Promise.resolve(result as Awaited<GuardResult>))],
  });
  try {
    for (result of [true, success(false), { isError: true, error: "not an Error" }]) {
      const checked = await rejection(app.resolve(port)({ input: undefined, access: undefined }));
      assert.ok(InternalFlowError.is(checked) && checked.cause instanceof TypeError);
    }
    const denied = failure(Forbidden("overridden denial"));
    result = denied;
    assert.equal(await rejection(app.resolve(port)({ input: undefined, access: undefined })), denied.error);
    assert.equal(executions, 0);
    assert.equal(constructions, 0);
  } finally {
    await app.stop();
  }
});

test("excluding a guard prevents an exposure from falling back to its raw run hook", async () => {
  let checks = 0;
  const access = guard({
    requirements: {},
    run: () => {
      checks++;
      return success();
    },
  });
  const port = expose({ requirements: {}, guards: { access }, run: () => success() });
  await assert.rejects(
    runApplication(defineApplication({ modules: [provideFlow([port]).exclude([access])] })),
    /guard is unavailable or excluded \(expose → guard\)/,
  );
  assert.equal(checks, 0);
});

test("guard executors are built once, unless a requirement makes them belong to each scope", async () => {
  const session = unit({ factory: () => ({}), lifetime: "scoped" });
  const access = guard({ run: () => success() });
  const scoped = guard({ requirements: { session }, run: () => success() });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { access, scoped } })] }));
  const first: unknown[] = [];
  try {
    await app.withScope((scope) => {
      first.push(scope.resolve(access), scope.resolve(scoped));
      assert.equal(scope.resolve(scoped), first[1]);
    });
    await app.withScope((scope) => {
      assert.equal(scope.resolve(access), first[0]);
      assert.notEqual(scope.resolve(scoped), first[1]);
    });
    assert.throws(() => app.resolve(access), /withScope/);
  } finally {
    await app.stop();
  }
});

test("native lifetime checks reject singleton capture of a scoped guard", async () => {
  const session = unit({ factory: () => ({}), lifetime: "scoped" });
  const access = guard({ requirements: { session }, run: () => success() });
  const singleton = unit({ requirements: { access }, factory: ({ access }) => access });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { singleton } })],
      }),
    ),
    /shorter lifetime/,
  );
});

test("directly resolved guards preserve failures, normalize defects and expire their default invocation signal", async () => {
  const defect = new Error("guard defect");
  const denial = failure(Forbidden("denied"));
  const signals: AbortSignal[] = [];
  const access = guard<string>()({
    requirements: {},
    run: (mode, ctx): GuardResult => {
      signals.push(ctx.signal);
      if (mode === "throw") {
        throw defect;
      }
      if (mode === "reject") {
        return Promise.reject(defect);
      }
      if (mode === "invalid") {
        return success(1) as unknown as GuardResult;
      }
      return mode === "deny" ? denial : success();
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { access } })] }));
  try {
    await app.withScope(async (scope) => {
      const check = scope.resolve(access);
      assert.equal(await check("deny"), denial);
      assert.deepEqual(await check("allow"), success());
      for (const mode of ["throw", "reject", "invalid"]) {
        const result = await check(mode);
        assert.ok(result.isError && InternalFlowError.is(result.error));
        if (mode === "invalid") {
          assert.ok(result.error.cause instanceof TypeError);
        } else {
          assert.equal(result.error.cause, defect);
        }
      }
      assert.ok(signals.every((signal) => signal.aborted));
      const controller = new AbortController();
      controller.abort("cancelled before execute");
      const result = await check("allow", { signal: controller.signal });
      assert.ok(result.isError && InputCancelledError.is(result.error));
      assert.equal(signals.length, 5);
    });
  } finally {
    await app.stop();
  }
});

test("a shared guard executor keeps concurrent invocation signals separate", { timeout: 2_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const signals = new Map<string, AbortSignal>();
  const denial = failure(Forbidden("cancelled actor"));
  const access = guard<string>()({
    requirements: {},
    run: async (actor, ctx) => {
      signals.set(actor, ctx.signal);
      if (signals.size === 2) {
        entered.resolve();
      }
      await finish.promise;
      return ctx.signal.aborted ? denial : success();
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { access } })],
    }),
  );
  try {
    const first = new AbortController();
    const second = new AbortController();
    await app.withScope(async (scope) => {
      const check = scope.resolve(access);
      const a = check("a", { signal: first.signal });
      const b = check("b", { signal: second.signal });
      await entered.promise;
      first.abort("request a cancelled");
      finish.resolve();
      assert.equal(await a, denial);
      assert.deepEqual(await b, success());
    });
    assert.equal(signals.get("a"), first.signal);
    assert.equal(signals.get("b"), second.signal);
    assert.equal(second.signal.aborted, false);
  } finally {
    finish.resolve();
    await app.stop();
  }
});

test("concurrent invocations keep their own actor in shared guards and handlers", async () => {
  const userOf = (actor: unknown) => (actor as { readonly userId?: string } | undefined)?.userId;
  const seen: string[] = [];
  const bothChecked = Promise.withResolvers<void>();
  let checked = 0;
  const access = guard({
    run: async (_, ctx) => {
      seen.push(`guard ${String(userOf(ctx.actor))}`);
      if (++checked === 2) {
        bothChecked.resolve();
      }
      // Each check waits until both are in flight, so the two executions interleave.
      await bothChecked.promise;
      return success();
    },
  });
  const whoAmI = command({ run: async (_, ctx) => success(userOf(ctx.actor)) });
  const exposure = expose({ handler: whoAmI, guards: { access } });
  const app = await runApplication(defineApplication({ modules: [provideFlow([exposure])] }));
  try {
    const invoke = app.resolve(exposure);
    const results = await Promise.all(
      ["alice", "bob"].map((userId) => invoke({ input: undefined, access: undefined, actor: { userId } })),
    );
    assert.deepEqual(results, ["alice", "bob"]);
    assert.deepEqual(seen.toSorted(), ["guard alice", "guard bob"]);
  } finally {
    await app.stop();
  }
});

test("a directly invoked handler supplies its actor to the guard it calls", async () => {
  const access = guard({ run: (_, ctx) => (ctx.actor === "alice" ? success() : failure(Forbidden("wrong actor"))) });
  const action = command({
    requirements: { access },
    run: async (_, ctx) => ctx.access(),
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { action } })] }));
  try {
    const result = await app.withScope((scope) => scope.resolve(action)(undefined, { actor: "alice" }));
    assert.deepEqual(result, success());
  } finally {
    await app.stop();
  }
});
