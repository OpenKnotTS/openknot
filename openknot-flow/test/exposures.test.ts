import type { GuardResult, InputInvoker } from "../src/index.ts";
import {
  expose,
  guard,
  InputCancelledError,
  InputUnavailableError,
  InternalFlowError,
  isExposure,
  isExposureComposition,
  isGuard,
  listener,
  query,
  writer,
} from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { rejection } from "./fixtures/rejection.ts";
import { error, failure, operation, reader, success } from "@openknot-ts/behavior";
import {
  plug,
  providePlugs,
  runApplication,
  defineApplication,
  composeModule,
  resource,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const Forbidden = error("Forbidden");
type Forbidden = ReturnType<typeof Forbidden>;
const allow = guard({ requirements: {}, run: () => success() });

function plainExposure() {
  return expose<number>()({ requirements: {}, guards: { access: allow }, run: (value) => success(value * 2) });
}

test("named guards receive their own inputs, execute in order and share a fresh scope with business behavior", async () => {
  const events: string[] = [];
  const released: number[] = [];
  const signals: AbortSignal[] = [];
  let serial = 0;
  const session = resource({
    initialize: () => {
      const id = ++serial;
      return Promise.resolve({
        value: { id },
        release() {
          released.push(id);
        },
      });
    },
    lifetime: "scoped",
  });
  const permissions = guard<{ actorId: string }>()({
    requirements: { session },
    run: (input, ctx) => {
      events.push(`permissions:${input.actorId}:${ctx.session.id}`);
      signals.push(ctx.signal);
      return success();
    },
  });
  const organization = guard<{ organizationId: number }>()({
    requirements: { session },
    run: (input, ctx) => {
      events.push(`organization:${input.organizationId}:${ctx.session.id}`);
      assert.equal(ctx.signal, signals.at(-1));
      return success();
    },
  });
  const port = expose<{ id: string }>()({
    requirements: { session },
    guards: { permissions, organization },
    run: (input, ctx) => {
      events.push(`execute:${input.id}:${ctx.session.id}`);
      assert.equal(ctx.signal, signals.at(-1));
      assert.ok(!("trigger" in ctx));
      return success({ id: input.id, session: ctx.session.id });
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    for (let id = 1; id <= 2; id++) {
      const result = await app.resolve(port)({
        input: { id: `r${id}` },
        permissions: { actorId: `u${id}` },
        organization: { organizationId: id },
      });
      assert.deepEqual(result, { id: `r${id}`, session: id });
    }
    assert.deepEqual(events, [
      "permissions:u1:1",
      "organization:1:1",
      "execute:r1:1",
      "permissions:u2:2",
      "organization:2:2",
      "execute:r2:2",
    ]);
    assert.deepEqual(released, [1, 2]);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.notEqual(signals[0], signals[1]);
  } finally {
    await app.stop();
  }
});

test("guard rejection preserves the failure/stack and skips later guards and business dependency construction", async () => {
  const expected = Forbidden("role access denied");
  const denied = failure(expected);
  const events: string[] = [];
  const business = unit({
    factory: () => {
      events.push("business:construct");
      return 1;
    },
    lifetime: "scoped",
  });
  const first = guard<boolean>()({
    requirements: {},
    run: (allowed) => {
      events.push("first");
      return allowed ? success() : denied;
    },
  });
  const second = guard({
    requirements: {},
    run: () => {
      events.push("second");
      return success();
    },
  });
  const port = expose({
    requirements: { business },
    guards: { first, second },
    run: (_input, ctx) => {
      events.push("execute");
      return success(ctx.business);
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    const rejected = await rejection(app.resolve(port)({ input: undefined, first: false, second: undefined }));
    assert.equal(rejected, expected);
    assert.equal(denied.error.stack, expected.stack);
    assert.deepEqual(events, ["first"]);
    assert.deepEqual(await app.resolve(port)({ input: undefined, first: true, second: undefined }), 1);
    assert.deepEqual(events, ["first", "first", "second", "business:construct", "execute"]);
  } finally {
    await app.stop();
  }
});

test("awaited guards complete before business dependencies are resolved", { timeout: 2_000 }, async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let constructed = 0;
  const business = unit({ factory: () => ++constructed, lifetime: "scoped" });
  const access = guard({
    requirements: {},
    run: async () => {
      started.resolve();
      await finish.promise;
      return success();
    },
  });
  const port = expose({
    requirements: { business },
    guards: { access },
    run: (_input, ctx) => success(ctx.business),
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    const work = app.resolve(port)({ input: undefined, access: undefined });
    await started.promise;
    assert.equal(constructed, 0);
    finish.resolve();
    assert.deepEqual(await work, 1);
  } finally {
    finish.resolve();
    await app.stop();
  }
});

test("guard-only reader requirements bind directly in infrastructure and share operation scope", async () => {
  const find = reader<(id: string) => Promise<string>>();
  const permitted = reader<(actorId: string) => Promise<boolean>>();
  let bindings = 0;
  const data = plug({
    port: reader.compose({ find, permitted }),
    bind: () => {
      bindings++;
      return {
        find: (id) => Promise.resolve(`role:${id}`),
        permitted: (id) => Promise.resolve(id === "u1"),
      };
    },
  });
  const access = guard<string>()({
    requirements: { permitted },
    run: async (actorId, ctx) => {
      return (await ctx.permitted(actorId)) ? success() : failure(Forbidden());
    },
  });
  const load = operation<string>()({
    requirements: { find },
    run: async (id, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.find(id) } }),
  });
  const port = expose<string>()({ requirements: { load }, guards: { access }, run: (id, ctx) => ctx.load(id) });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([port]), composeModule({ providers: { data } })] }),
  );
  try {
    assert.equal(bindings, 0);
    assert.deepEqual(await app.resolve(port)({ input: "r1", access: "u1" }), {
      output: { changeType: "updated" as const, next: "role:r1" },
    });
    assert.equal(bindings, 1);
  } finally {
    await app.stop();
  }
});

test("the same guard reference can be declared under distinct input names", async () => {
  const values: string[] = [];
  const access = guard<string>()({
    requirements: {},
    run: (value) => {
      values.push(value);
      return success();
    },
  });
  const port = expose({ requirements: {}, guards: { source: access, destination: access }, run: () => success() });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    await app.resolve(port)({ input: undefined, source: "source-org", destination: "destination-org" });
    assert.deepEqual(values, ["source-org", "destination-org"]);
  } finally {
    await app.stop();
  }
});

test("guard throws, rejections, invalid outcomes and valued successes become technical failures", async () => {
  const defect = new Error("permission backend unavailable");
  const access = guard<string>()({
    requirements: {},
    run: (mode): GuardResult => {
      if (mode === "throw") {
        throw defect;
      }
      if (mode === "reject") {
        return Promise.reject(defect);
      }
      if (mode === "value") {
        return success(false) as unknown as GuardResult;
      }
      return true as unknown as GuardResult;
    },
  });
  let calls = 0;
  const port = expose({
    requirements: {},
    guards: { access },
    run: () => {
      calls++;
      return success();
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    for (const mode of ["throw", "reject", "value", "invalid"]) {
      const error = await rejection(app.resolve(port)({ input: undefined, access: mode }));
      assert.ok(InternalFlowError.is(error));
      if (mode === "throw" || mode === "reject") {
        assert.equal(error.cause, defect);
      } else {
        assert.ok(error.cause instanceof TypeError);
      }
    }
    assert.equal(calls, 0);
  } finally {
    await app.stop();
  }
});

test("exposure handler failures preserve expected errors and contain unexpected throws", async () => {
  const denied = failure(Forbidden("business failure"));
  const defect = new Error("handler defect");
  const port = expose<string>()({
    requirements: {},
    guards: { access: allow },
    run: (mode) => {
      if (mode === "expected") {
        return denied;
      }
      throw defect;
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    assert.equal(await rejection(app.resolve(port)({ input: "expected", access: undefined })), denied.error);
    const error = await rejection(app.resolve(port)({ input: "throw", access: undefined }));
    assert.ok(InternalFlowError.is(error) && error.cause === defect);
  } finally {
    await app.stop();
  }
});

test("malformed envelopes never skip guards and reject with technical failures", async () => {
  let evaluations = 0;
  const access = guard({
    requirements: {},
    run: () => {
      evaluations++;
      return success();
    },
  });
  const port = expose({ requirements: {}, guards: { access }, run: () => success() });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    const invoke = app.resolve(port);
    const requests: readonly unknown[] = [
      null,
      undefined,
      [],
      { input: 1, other: undefined },
      { input: 1, access: undefined, extra: undefined },
      { input: 1, access: undefined, signal: {} },
      {
        input: 1,
        get guards() {
          throw new Error("getter failed");
        },
      },
    ];
    for (const request of requests) {
      assert.ok(InternalFlowError.is(await rejection(Reflect.apply(invoke, undefined, [request]))));
    }
    assert.equal(evaluations, 0);
  } finally {
    await app.stop();
  }
});

test("guard scope failures retain initialization/cleanup causes and the original guard rejection", async () => {
  const failedToOpen = new Error("open failed");
  const failedToClose = new Error("close failed");
  const expected = Forbidden("denied");
  const unavailable = resource({
    initialize: () => Promise.reject(failedToOpen),
    lifetime: "scoped",
  });
  const cleanup = resource({
    initialize: () =>
      Promise.resolve({
        value: 1,
        release() {
          throw failedToClose;
        },
      }),
    lifetime: "scoped",
  });
  for (const selected of [unavailable, cleanup]) {
    // The guard needs the session, so the exposure's scope acquires it.
    const access = guard({ requirements: { selected }, run: () => failure(expected) });
    const port = expose({ requirements: {}, guards: { access }, run: () => success() });
    const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
    try {
      const error = await rejection(app.resolve(port)({ input: undefined, access: undefined }));
      assert.ok(InternalFlowError.is(error));
      if (selected === unavailable) {
        assert.equal(error.cause, failedToOpen);
      } else {
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors[0], expected);
        const cleanupError: unknown = error.cause.errors[1];
        assert.ok(cleanupError instanceof AggregateError);
        assert.equal(cleanupError.errors[0], failedToClose);
      }
    } finally {
      await app.stop();
    }
  }
});

test("an exposure acquires only the scoped resources its guards, handler and bindings may need", async () => {
  const opened: string[] = [];
  const session = (name: string, fails = false) =>
    resource({
      lifetime: "scoped",
      async initialize() {
        opened.push(name);
        if (fails) {
          throw new Error(`${name} unavailable`);
        }
        return { value: name, release() {} };
      },
    });
  const roles = session("roles");
  const audit = session("audit", true);
  const findRole = reader<() => string>();
  const findAudit = reader<() => string>();
  const roleData = plug({
    port: findRole,
    requirements: { roles },
    bind:
      ({ roles }) =>
      () =>
        roles,
  });
  const auditData = plug({
    port: findAudit,
    requirements: { audit },
    bind:
      ({ audit }) =>
      () =>
        audit,
  });
  const getRole = query({ requirements: { findRole }, run: (_, ctx) => success(ctx.findRole()) });
  const getAudit = query({ requirements: { findAudit }, run: (_, ctx) => success(ctx.findAudit()) });
  const roleApi = expose({ handler: getRole });
  const auditApi = expose({ handler: getAudit });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([roleApi, auditApi]), providePlugs([roleData, auditData])] }),
  );
  try {
    // The audit session fails to open, yet an exposure that cannot reach it never acquires it.
    assert.deepEqual(await app.resolve(roleApi)({ input: undefined }), "roles");
    assert.deepEqual(opened, ["roles"]);
    assert.ok(InternalFlowError.is(await rejection(app.resolve(auditApi)({ input: undefined }))));
    assert.deepEqual(opened, ["roles", "audit"]);
  } finally {
    await app.stop();
  }
});

test("an exposure forwards to a reader as a query that responds with what it reads", async () => {
  const findRole = reader<(id: string) => Promise<string>>();
  const countRoles = reader<() => number>();
  const data = plug({
    port: reader.compose({ findRole, countRoles }),
    bind: () => ({ findRole: (id) => Promise.resolve(`role:${id}`), countRoles: () => 2 }),
  });
  const roleApi = expose({ handler: findRole, guards: { access: allow } });
  const countApi = expose({ handler: countRoles });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([roleApi, countApi]), providePlugs([data])] }),
  );
  try {
    assert.equal(await app.resolve(roleApi)({ input: "r1", access: undefined }), "role:r1");
    assert.equal(await app.resolve(countApi)({ input: undefined }), 2);
  } finally {
    await app.stop();
  }
});

test(
  "pre-cancelled calls open no scope and cancellation between guards prevents business execution",
  {
    timeout: 2_000,
  },
  async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let scopes = 0;
    let executions = 0;
    let secondGuardCalls = 0;
    const second = guard({
      requirements: {},
      run: () => {
        secondGuardCalls++;
        return success();
      },
    });
    const session = resource({
      initialize: () => {
        scopes++;
        return Promise.resolve({ value: 1, release() {} });
      },
      lifetime: "scoped",
    });
    const access = guard({
      requirements: { session },
      run: async (_input, ctx) => {
        void ctx.session;
        entered.resolve();
        await finish.promise;
        return success();
      },
    });
    const port = expose({
      requirements: {},
      guards: { access, second },
      run: () => {
        executions++;
        return success();
      },
    });
    const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
    try {
      const controller = new AbortController();
      controller.abort("already cancelled");
      const early = app.resolve(port)({
        input: undefined,
        access: undefined,
        second: undefined,
        signal: controller.signal,
      });
      await assert.rejects(early, InputCancelledError.is);
      assert.equal(scopes, 0);
      const active = new AbortController();
      const work = app.resolve(port)({ input: undefined, access: undefined, second: undefined, signal: active.signal });
      await entered.promise;
      active.abort("client cancelled");
      finish.resolve();
      await assert.rejects(work, InputCancelledError.is);
      assert.equal(scopes, 1);
      assert.equal(executions, 0);
      assert.equal(secondGuardCalls, 0);
    } finally {
      finish.resolve();
      await app.stop();
    }
  },
);

test(
  "input adapters bind exposures and graceful shutdown drains active guard/handler work",
  {
    timeout: 2_000,
  },
  async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    const session = resource({
      initialize: () =>
        Promise.resolve({
          value: 1,
          release() {
            events.push("scope:release");
          },
        }),
      lifetime: "scoped",
    });
    const access = guard({
      requirements: { session },
      run: async (_input, ctx) => {
        signal = ctx.signal;
        entered.resolve();
        await finish.promise;
        return success();
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
    let invoke: InputInvoker<typeof port> | undefined;
    const route = plug({
      port,
      requirements: {},
      bind: (ctx) => {
        invoke = ctx.invoke;
        return {
          release() {
            events.push("route:release");
          },
        };
      },
    });
    const app = await runApplication(
      defineApplication({
        modules: [provideFlow([port]), composeModule({ providers: { route } })],
      }),
    );
    assert.ok(invoke);
    const request = { input: undefined, access: undefined };
    const work = invoke(request);
    await entered.promise;
    const stopping = app.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(signal?.aborted, false);
    assert.deepEqual(events, ["route:release"]);
    await assert.rejects(invoke(request), InputUnavailableError.is);
    finish.resolve();
    await work;
    await stopping;
    assert.equal(signal?.aborted, true);
    assert.deepEqual(events, ["route:release", "execute", "scope:release"]);
  },
);

test("exposure adapters may await guarded delivery during startup binding", async () => {
  const port = plainExposure();
  let delivered = false;
  const route = plug({
    port,
    requirements: {},
    bind: async ({ invoke }) => {
      assert.deepEqual(await invoke({ input: 3, access: undefined }), 6);
      delivered = true;
      return { release() {} };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { route } })] }));
  try {
    assert.ok(app.ready && delivered);
  } finally {
    await app.stop();
  }
});

test("exposure compositions keep definitions independent, immutable and usable in flow imports", async () => {
  const first = plainExposure();
  const second = plainExposure();
  const members = { first, second };
  const group = expose.compose(members);
  Object.assign(members, { first: second });
  assert.ok(isExposure(first) && isExposureComposition(group) && isGuard(allow));
  assert.ok(Object.isFrozen(group) && Object.isFrozen(group.members));
  assert.deepEqual(group.members, { first, second });
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([group, () => import("./fixtures/exposures.ts")]).includeOnly([first])],
    }),
  );
  try {
    assert.deepEqual(await app.resolve(first)({ input: 2, access: undefined }), 4);
    assert.deepEqual(await app.resolve(second)({ input: 4, access: undefined }), 8);
    const { fixtureExposure } = await import("./fixtures/exposures.ts");
    assert.deepEqual(await app.resolve(fixtureExposure)({ input: "x", access: undefined }), "x");
  } finally {
    await app.stop();
  }
  for (const ports of [[], [first, first], [allow], [listener({ requirements: {}, run: () => success() })]]) {
    assert.throws(() => Reflect.apply(expose.compose, undefined, [ports]), /exposures|Duplicate/);
  }
});

test("declarations snapshot guards/requirements and reject invalid guard declarations", async () => {
  const checked: string[] = [];
  const reference = unit({ factory: () => "original", lifetime: "scoped" });
  const requirements = { reference };
  const access = guard({
    requirements,
    run: (_input, ctx) => {
      checked.push(ctx.reference);
      return success();
    },
  });
  requirements.reference = unit({ factory: () => "changed", lifetime: "scoped" });
  const guards = { access };
  const port = expose({ requirements: {}, guards, run: () => success() });
  guards.access = guard({
    requirements,
    run: () => {
      throw new Error("changed guard");
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([port])] }));
  try {
    await app.resolve(port)({ input: undefined, access: undefined });
    assert.deepEqual(checked, ["original"]);
  } finally {
    await app.stop();
  }
  for (const value of [null, [], { access: reader<() => void>() }, { access: () => true }]) {
    assert.throws(
      () => Reflect.apply(expose, undefined, [{ requirements: {}, guards: value, run: () => success() }]),
      /guards|guard/,
    );
  }
  assert.throws(() => Reflect.apply(guard, undefined, [{ requirements: {}, run: 1 }]), /run/);
  assert.throws(() => guard({ requirements: { signal: reference }, run: () => success() }), /Reserved/);
  assert.throws(() => Reflect.apply(provideFlow, undefined, [[access]]), /does not accept a guard/);
});

test("guard dependencies retain hard exclusions and missing bindings fail at startup", async () => {
  const find = reader<() => boolean>();
  const access = guard({
    requirements: { find },
    run: (_input, ctx) => (ctx.find() ? success() : failure(Forbidden())),
  });
  const port = expose({ requirements: {}, guards: { access }, run: () => success() });
  await assert.rejects(
    // @ts-expect-error The compiler reports the unbound guard reader; this checks the startup backstop.
    runApplication(defineApplication({ modules: [provideFlow([port])] })),
    /reader 'find' has no implementation \(expose → guard → find\)/,
  );
  await assert.rejects(
    // @ts-expect-error Excluding the contract leaves it unbound at compile time as well.
    runApplication(defineApplication({ modules: [provideFlow([port]).exclude([find])] })),
    /reader 'find' is unavailable or excluded \(expose → guard → find\)/,
  );
});

test("exposures support writers in business requirements after successful guards", async () => {
  const saved: string[] = [];
  const save = writer<(name: string) => void>();
  const binding = plug({
    port: save,
    bind: () => (name) => {
      saved.push(name);
    },
  });
  const port = expose<string>()({
    requirements: { save },
    guards: { access: allow },
    run: (name, ctx) => {
      ctx.save(name);
      return success(name);
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([port]), composeModule({ providers: { binding } })] }),
  );
  try {
    assert.deepEqual(await app.resolve(port)({ input: "Dispatcher", access: undefined }), "Dispatcher");
    assert.deepEqual(saved, ["Dispatcher"]);
  } finally {
    await app.stop();
  }
});
