import { integratedBy } from "./integration.ts";
import type { AnyProvider, Application, DefinitionAdapter, Definition, ResourceHandle } from "@openknot-ts/wire";
import {
  applicationStatus,
  describeApplication,
  runApplication,
  hook,
  defineApplication,
  composeModule,
  optional,
  override,
  requiredBy,
  resource,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

test("startup and shutdown have explicit order and readiness transitions", async () => {
  const events: string[] = [];
  const database = resource({
    async initialize() {
      events.push("database:open");
      return {
        value: { connected: true },
        release() {
          events.push("database:close");
        },
      };
    },
  });
  const cache = resource({
    requirements: { database },
    async initialize({ database }: { database: { connected: boolean } }) {
      assert.equal(database.connected, true);
      events.push("cache:open");
      return {
        value: 42,
        release() {
          events.push("cache:close");
        },
      };
    },
  });
  const root = unit({
    requirements: { cache },
    factory: ({ cache }: { cache: number }) => {
      events.push("root");
      return cache;
    },
  });
  const task = hook({
    run() {
      events.push("task:run");
    },
  });
  const api = hook({
    run() {
      events.push("api:start");
    },
  });
  const stopApi = hook({
    requirements: { database },
    run({ database }) {
      assert.equal(app.status, "stopping");
      assert.equal(database.connected, true);
      events.push("api:stop");
    },
  });
  const finalize = hook({
    run() {
      events.push("task:close");
    },
  });
  const module = composeModule({ providers: { database, cache, root } }).includeOnly([root]);
  // The stop hook reads app, so its type is declared rather than inferred from its own initializer.
  const app: Application = await runApplication(
    defineApplication({
      modules: requiredBy(module),
      startupTasks: [task, api],
      shutdownTasks: [stopApi, finalize],
    }),
  );
  assert.equal(app.resolve(root), 42);
  assert.equal(app.ready, true);
  assert.deepEqual(events, ["database:open", "cache:open", "root", "task:run", "api:start"]);
  const stop = app.stop();
  assert.equal(app.stop(), stop);
  assert.equal(app.ready, false);
  await stop;
  assert.equal(app.status, "stopped");
  assert.deepEqual(events.slice(5), ["api:stop", "task:close", "cache:close", "database:close"]);
  await app.stop();
  assert.equal(events.length, 9);
});

test(
  "resources are acquired without a list, in parallel, each after what it depends on",
  {
    timeout: 2_000,
  },
  async () => {
    const events: string[] = [];
    const databaseStarted = Promise.withResolvers<void>();
    const metricsStarted = Promise.withResolvers<void>();
    const handle = (name: string) => ({
      value: name,
      release() {
        events.push(`${name}:close`);
      },
    });
    // Each waits until the other has started, so they can only finish when they are acquired together.
    const database = resource({
      async initialize() {
        events.push("database:open");
        databaseStarted.resolve();
        await metricsStarted.promise;
        events.push("database:ready");
        return handle("database");
      },
    });
    const metrics = resource({
      async initialize() {
        events.push("metrics:open");
        metricsStarted.resolve();
        await databaseStarted.promise;
        return handle("metrics");
      },
    });
    // The cache needs the database through a unit, so it waits for it.
    const pool = unit({ requirements: { database }, factory: ({ database }) => database });
    const cache = resource({
      requirements: { pool },
      async initialize() {
        events.push("cache:open");
        return handle("cache");
      },
    });
    // Reached only as a dependency of a listed unit.
    const reporter = unit({ requirements: { metrics }, factory: ({ metrics }) => metrics });
    const opened = (name: string) =>
      resource({
        async initialize() {
          events.push(`${name}:open`);
          return handle(name);
        },
      });
    const overridden = opened("overridden");
    const unused = opened("unused");
    const offered = opened("offered");
    const app = await runApplication(
      defineApplication({
        modules: composeModule({ providers: { offered } }).requiredBy(
          composeModule({ providers: { cache, database, reporter, overridden } }),
          // Available but listed by no root module, and only made available: neither is acquired.
          composeModule({ providers: { unused } }).includeOnly([]),
        ),
      }),
      { overrides: [override(overridden, "stub")] },
    );
    assert.deepEqual(new Set(events), new Set(["database:open", "metrics:open", "database:ready", "cache:open"]));
    assert.ok(events.indexOf("database:ready") < events.indexOf("cache:open"));
    assert.equal(app.resolve(cache), "cache");
    assert.equal(app.resolve(overridden), "stub");
    events.length = 0;
    await app.stop();
    // Release runs in reverse completion order: the cache before the database it needs.
    assert.equal(events.length, 3);
    assert.ok(events.indexOf("cache:close") < events.indexOf("database:close"));
  },
);

test("resourceOrder acquires the listed resources one by one, each after what it needs, before the rest", async () => {
  const events: string[] = [];
  const tracked = (name: string) => async () => {
    events.push(`${name}:open`);
    // A tick lets anything wrongly running alongside start before this one is ready.
    await Promise.resolve();
    events.push(`${name}:ready`);
    return { value: name, release() {} };
  };
  const telemetry = resource({ initialize: tracked("telemetry") });
  const database = resource({ initialize: tracked("database") });
  const cache = resource({ requirements: { database }, initialize: tracked("cache") });
  const broker = resource({ initialize: tracked("broker") });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { broker, cache, database, telemetry } })],
      resourceOrder: [telemetry, cache],
    }),
  );
  await app.stop();
  assert.deepEqual(events, [
    "telemetry:open",
    "telemetry:ready",
    "database:open",
    "database:ready",
    "cache:open",
    "cache:ready",
    "broker:open",
    "broker:ready",
  ]);
  const notResource = unit({ factory: () => 1 });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { notResource } })],
        resourceOrder: [notResource as never],
      }),
    ),
    /resourceOrder needs a resource, not the singleton unit 'notResource'/,
  );
});

test("resourceOrder keeps the rest after every listed resource, also one an earlier listed resource needs", async () => {
  const events: string[] = [];
  const tracked = (name: string) => async () => {
    events.push(`${name}:open`);
    await Promise.resolve();
    events.push(`${name}:ready`);
    return { value: name, release() {} };
  };
  const database = resource({ initialize: tracked("database") });
  const migrations = resource({ requirements: { database }, initialize: tracked("migrations") });
  const cache = resource({ initialize: tracked("cache") });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { cache, migrations } })],
      resourceOrder: [migrations, database],
    }),
  );
  await app.stop();
  assert.deepEqual(events, [
    "database:open",
    "database:ready",
    "migrations:open",
    "migrations:ready",
    "cache:open",
    "cache:ready",
  ]);
});

test("a scope's own resource list follows resourceOrder", async () => {
  const events: string[] = [];
  const tracked = (name: string) =>
    resource({
      lifetime: "scoped",
      async initialize() {
        events.push(`${name}:open`);
        await Promise.resolve();
        events.push(`${name}:ready`);
        return { value: name, release() {} };
      },
    });
  const session = tracked("session");
  const cursor = tracked("cursor");
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { cursor, session } })], resourceOrder: [session] }),
  );
  try {
    await app.withScope(() => undefined, { resources: [cursor, session] });
    assert.deepEqual(events, ["session:open", "session:ready", "cursor:open", "cursor:ready"]);
  } finally {
    await app.stop();
  }
});

test("the first failed acquisition aborts the ones in progress and releases what was acquired", async () => {
  const events: string[] = [];
  let slowSignal: AbortSignal | undefined;
  const ready = resource({
    async initialize() {
      events.push("ready:open");
      return {
        value: 1,
        release() {
          events.push("ready:close");
        },
      };
    },
  });
  const slow = resource({
    initialize: (_dependencies, { signal }) =>
      new Promise<ResourceHandle<number>>((_resolve, reject) => {
        slowSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  const broken = resource({
    async initialize() {
      await Promise.resolve();
      throw new Error("broken");
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { ready, slow, broken } })] })),
    (error: Error) => {
      // The cancelled acquisition reports the same failure, so the startup rejects with it alone.
      assert.equal(error.message, "broken");
      return true;
    },
  );
  assert.equal(slowSignal?.aborted, true);
  assert.deepEqual(events, ["ready:open", "ready:close"]);
});

test("independent acquisition failures are reported together, the first as the cause", async () => {
  const first = new Error("first");
  const second = new Error("second");
  const one = resource({
    async initialize(): Promise<ResourceHandle<number>> {
      throw first;
    },
  });
  const two = resource({
    async initialize(): Promise<ResourceHandle<number>> {
      throw second;
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { one, two } })] })),
    (error: AggregateError) => {
      assert.equal(error.message, "Resource acquisition failed.");
      assert.deepEqual(error.errors, [first, second]);
      assert.equal(error.cause, first);
      return true;
    },
  );
});

test("a handle without value fails startup and is still released", async () => {
  let released = false;
  const empty = resource({
    initialize: async () =>
      ({
        release() {
          released = true;
        },
      }) as unknown as ResourceHandle<number>,
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { empty } })] })),
    /A resource returned a handle without value\./,
  );
  assert.equal(released, true);
});

test("a hook bound to another hook runs in its place", async () => {
  const events: string[] = [];
  const announce = hook({
    run: () => {
      events.push("default");
    },
  });
  const replacement = hook({
    provides: announce,
    run: () => {
      events.push("replacement");
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { replacement } })], startupTasks: [announce] }),
  );
  await app.stop();
  assert.deepEqual(events, ["replacement"]);
});

test("failed resource initialization rolls back acquired handles, preserving the original error", async () => {
  const events: string[] = [];
  const error = new Error("cannot connect");
  const first = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          events.push("first:close");
        },
      };
    },
  });
  const second = resource({
    async initialize(): Promise<ResourceHandle<number>> {
      throw error;
    },
  });
  const module = composeModule({ providers: { first, second } });
  await assert.rejects(
    runApplication(defineApplication({ modules: requiredBy(module) })),
    (caught) => caught === error,
  );
  assert.deepEqual(events, ["first:close"]);
});

test("all acquired resources are released even when startup and cleanup fail", async () => {
  const events: string[] = [];
  const startupError = new Error("startup");
  const cleanupError = new Error("cleanup");
  const first = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          events.push("first");
        },
      };
    },
  });
  const second = resource({
    async initialize() {
      return {
        value: 2,
        release() {
          events.push("second");
          throw cleanupError;
        },
      };
    },
  });
  const failing = hook({
    run() {
      throw startupError;
    },
  });
  const finalize = hook({
    run() {
      events.push("task");
    },
  });
  const module = composeModule({ providers: { first, second, failing } });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: requiredBy(module),
        startupTasks: [failing],
        shutdownTasks: [finalize],
      }),
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, startupError);
      assert.deepEqual(error.errors, [startupError, cleanupError]);
      return true;
    },
  );
  assert.deepEqual(events, ["task", "second", "first"]);
});

test("shutdown hooks unwind partial startup before resources close", async () => {
  const events: string[] = [];
  const handle = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          events.push("resource");
        },
      };
    },
  });
  const first = hook({
    run() {
      events.push("first:start");
    },
  });
  const second = hook({
    run() {
      throw new Error("listen failed");
    },
  });
  const stopFirst = hook({
    run() {
      events.push("first:stop");
    },
  });
  const stopSecond = hook({
    run() {
      events.push("second:stop");
    },
  });
  const module = composeModule({ providers: { handle, first, second } });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: requiredBy(module),
        startupTasks: [first, second],
        shutdownTasks: [stopSecond, stopFirst],
      }),
    ),
    /listen failed/,
  );
  assert.deepEqual(events, ["first:start", "second:stop", "first:stop", "resource"]);
});

test("resource overrides skip acquisition and leave externally supplied values open", async () => {
  let initialized = 0;
  let released = 0;
  const database = resource({
    async initialize() {
      initialized++;
      return {
        value: { connected: true },
        release() {
          released++;
        },
      };
    },
  });
  const consumer = unit({
    requirements: { database },
    factory: ({ database }: { database: { connected: boolean } }) => database.connected,
  });
  const module = composeModule({ providers: { database, consumer } });
  const app = await runApplication(defineApplication({ modules: requiredBy(module) }), {
    overrides: [override(database, { connected: false })],
  });
  assert.equal(app.resolve(consumer), false);
  await app.stop();
  assert.equal(initialized, 0);
  assert.equal(released, 0);
});

test("resource requirements can resolve undefined and retain strict lifetime checks", async () => {
  const config = unit({ factory: (): number | undefined => undefined });
  const optionalResource = resource({
    requirements: { config },
    async initialize({ config }) {
      return { value: config ?? 10, release() {} };
    },
  });
  const module = composeModule({ providers: { optionalResource } });
  const app = await runApplication(defineApplication({ modules: requiredBy(module) }));
  assert.equal(app.resolve(optionalResource), 10);
  await app.stop();
  const scoped = unit({ factory: () => 42, lifetime: "scoped" });
  const invalid = resource({
    requirements: { scoped },
    async initialize({ scoped }: { scoped: number }) {
      return { value: scoped, release() {} };
    },
  });
  const invalidModule = composeModule({ providers: { scoped, invalid } }).includeOnly([invalid]);
  await assert.rejects(runApplication(defineApplication({ modules: requiredBy(invalidModule) })), /shorter lifetime/);
});

test("each scope owns a ready resource and releases it even after work fails", async () => {
  const events: string[] = [];
  let id = 0;
  const session = resource({
    async initialize() {
      const value = ++id;
      events.push(`open:${value}`);
      return {
        value,
        release() {
          events.push(`close:${value}`);
        },
      };
    },
    lifetime: "scoped",
  });
  const consumer = unit({
    requirements: { session },
    factory: ({ session }: { session: number }) => session,
    lifetime: "scoped",
  });
  const module = composeModule({ providers: { session, consumer } }).includeOnly([session]);
  const app = await runApplication(defineApplication({ modules: requiredBy(module) }));
  const first = await app.withScope((scope) => scope.resolve(consumer));
  assert.equal(first, 1);
  await assert.rejects(
    app.withScope((scope) => {
      assert.equal(scope.resolve(consumer), 2);
      throw new Error("business failure");
    }),
    /business failure/,
  );
  assert.deepEqual(events, ["open:1", "close:1", "open:2", "close:2"]);
  await app.stop();
});

test("scope work errors and cleanup errors are both retained", async () => {
  const workError = new Error("work");
  const cleanupError = new Error("cleanup");
  const session = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          throw cleanupError;
        },
      };
    },
    lifetime: "scoped",
  });
  const module = composeModule({ providers: { session } });
  const app = await runApplication(defineApplication({ modules: requiredBy(module) }));
  await assert.rejects(
    app.withScope(() => {
      throw workError;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [workError, cleanupError]);
      return true;
    },
  );
  await app.stop();
});

test("shutdown runs hooks, drains active scopes, then closes shared resources", async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const database = resource({
    async initialize() {
      return {
        value: 42,
        release() {
          events.push("database:close");
        },
      };
    },
  });
  const session = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          events.push("session:close");
        },
      };
    },
    lifetime: "scoped",
  });
  const api = hook({
    run() {
      events.push("api:stop");
    },
  });
  const module = composeModule({ providers: { database, session, api } });
  const app = await runApplication(
    defineApplication({
      modules: requiredBy(module),
      shutdownTasks: [api],
    }),
  );
  const operation = app.withScope(async (scope) => {
    entered.resolve();
    await finish.promise;
    assert.equal(scope.resolve(database), 42);
    events.push("work:done");
  });
  await entered.promise;
  const stopping = app.stop();
  await assert.rejects(
    app.withScope(() => undefined),
    /stopping/,
  );
  assert.deepEqual(events, ["api:stop"]);
  finish.resolve();
  await operation;
  await stopping;
  assert.deepEqual(events, ["api:stop", "work:done", "session:close", "database:close"]);
});

test("shutdown attempts all hooks and cleanup and shares a single rejected stop promise", async () => {
  const events: string[] = [];
  const api = hook({
    run() {
      events.push("api");
      throw new Error("stop failed");
    },
  });
  const next = hook({
    run() {
      events.push("next");
    },
  });
  const database = resource({
    async initialize() {
      return {
        value: 42,
        release() {
          events.push("database");
        },
      };
    },
  });
  const module = composeModule({ providers: { api, database } });
  const app = await runApplication(defineApplication({ modules: requiredBy(module), shutdownTasks: [api, next] }));
  const stop = app.stop();
  assert.equal(stop, app.stop());
  await assert.rejects(stop, AggregateError);
  assert.equal(app.status, "stopped");
  assert.deepEqual(events, ["api", "next", "database"]);
});

test("an explicit lightweight scope skips default execution resources without changing their ownership", async () => {
  let initialized = 0,
    released = 0;
  const session = resource({
    lifetime: "scoped",
    async initialize() {
      initialized++;
      return {
        value: initialized,
        release() {
          released++;
        },
      };
    },
  });
  const definition = defineApplication({
    modules: [composeModule({ providers: { session } })],
  });
  const app = await runApplication(definition);
  try {
    await app.withScope(
      () => {
        assert.equal(initialized, 0);
      },
      { resources: [] },
    );
    await app.withScope((scope) => {
      assert.equal(scope.resolve(session), 1);
    });
    assert.equal(released, 1);
    await app.withScope(
      (scope) => {
        assert.equal(scope.resolve(session), 2);
      },
      { resources: [session] },
    );
    assert.equal(released, 2);
  } finally {
    await app.stop();
  }
});

test("a scope opened for a root acquires only the scoped resources that root may need", async () => {
  const events: string[] = [];
  const sessions = resource({
    lifetime: "scoped",
    async initialize() {
      events.push("sessions");
      return { value: "sessions", release() {} };
    },
  });
  const reports = resource({
    lifetime: "scoped",
    async initialize(): Promise<{ value: string; release(): void }> {
      events.push("reports");
      throw new Error("reports unavailable");
    },
  });
  // Through a unit and a bound optional dependency: every branch the root may take counts.
  const repository = unit({ lifetime: "scoped", requirements: { sessions }, factory: ({ sessions }) => sessions });
  const login = unit({
    lifetime: "scoped",
    requirements: { repository: optional(repository) },
    factory: ({ repository }) => repository,
  });
  const report = unit({ lifetime: "scoped", requirements: { reports }, factory: ({ reports }) => reports });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { login, repository, report } })] }),
  );
  try {
    // A failing resource the root cannot reach does not fail it.
    assert.equal(await app.withScope((scope) => scope.resolve(login), { root: login }), "sessions");
    assert.deepEqual(events, ["sessions"]);
    await assert.rejects(
      app.withScope((scope) => scope.resolve(report), { root: report }),
      /reports unavailable/,
    );
    // Without a root, a scope keeps acquiring every scoped resource the application reaches.
    events.length = 0;
    await assert.rejects(
      app.withScope(() => {}),
      /reports unavailable/,
    );
    assert.deepEqual([...events].sort(), ["reports", "sessions"]);
    // A scope names its own resources or its root, not both; the runtime also rejects it for untyped callers.
    await assert.rejects(
      // @ts-expect-error The options are mutually exclusive.
      app.withScope(() => {}, { root: login, resources: [] }),
      /either its own resources or the root/,
    );
  } finally {
    await app.stop();
  }
});

test("a root's scope acquires what executes in it, and a definition that opens its own scope acquires its own", async () => {
  const events: string[] = [];
  const session = (name: string) =>
    resource({
      lifetime: "scoped",
      async initialize() {
        events.push(name);
        return { value: name, release() {} };
      },
    });
  const inline = session("inline");
  const boundary = session("boundary");
  const aliased = session("aliased");
  // An integration whose definitions reach their dependencies only when they execute.
  interface Executed {
    readonly name: string;
    readonly references: readonly Definition[];
    readonly opensScope?: true;
  }
  const executed = (definition: Executed): Definition => definition as unknown as Definition;
  const markers = new Set<object>();
  const mark = (definition: Executed) => {
    const marked = { ...definition, ...integratedBy("test:executions", () => adapter) };
    markers.add(marked);
    return executed(marked);
  };
  const adapter: DefinitionAdapter = {
    name: "test:executions",
    adapt: (value) => {
      if (!markers.has(value)) {
        return undefined;
      }
      const { name, references, opensScope } = value as Executed;
      return {
        reference: value as Definition,
        references,
        provider: unit({ factory: () => name }),
        ...(opensScope === undefined ? {} : { opensScope }),
      };
    },
  };
  // A singleton that runs its deferred dependencies in its caller's scope, and an invoker that opens its own.
  const sameScope = mark({ name: "same", references: [inline] });
  const ownScope = mark({ name: "own", references: [boundary], opensScope: true });
  const root = unit({
    lifetime: "scoped",
    requirements: { sameScope, ownScope },
    factory: (values) => values,
  });
  // A root executes in its own scope: its deferred dependencies are its own, boundary or not.
  const direct = mark({ name: "direct", references: [aliased], opensScope: true });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { root, direct, inline, boundary, aliased } })],
    }),
  );
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(root), { root }), {
      sameScope: "same",
      ownScope: "own",
    });
    assert.deepEqual(events, ["inline"]);
    events.length = 0;
    await app.withScope(() => {}, { root: direct });
    assert.deepEqual(events, ["aliased"]);
  } finally {
    await app.stop();
  }
});
test("application hooks snapshot phase lists, preserve overrides and do not construct unused hooks", async () => {
  const events: string[] = [];
  const selected = hook({
    run() {
      events.push("original");
    },
  });
  const unused = hook({
    run() {
      throw new Error("Unused hook was run");
    },
  });
  const startupTasks = [selected];
  const shutdownTasks = [selected];
  const definition = defineApplication({
    modules: [composeModule({ providers: { unused } })],
    startupTasks,
    shutdownTasks,
  });
  startupTasks.length = 0;
  shutdownTasks.length = 0;
  assert.ok(Object.isFrozen(definition.options.startupTasks));
  assert.ok(Object.isFrozen(definition.options.shutdownTasks));
  const app = await runApplication(definition, {
    overrides: [
      override(selected, {
        run() {
          events.push("overridden");
        },
      }),
    ],
  });
  assert.deepEqual(events, ["overridden"]);
  await app.stop();
  await app.stop();
  assert.deepEqual(events, ["overridden", "overridden"]);
});

test("resource initialization failure skips application hooks and rolls back only acquired resources", async () => {
  const events: string[] = [];
  const expected = new Error("database unavailable");
  const first = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          events.push("resource:close");
        },
      };
    },
  });
  const failing = resource({
    async initialize(): Promise<ResourceHandle<number>> {
      throw expected;
    },
  });
  const task = hook({
    run() {
      events.push("hook");
    },
  });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { first, failing } })],
        startupTasks: [task],
        shutdownTasks: [task],
      }),
    ),
    (error) => error === expected,
  );
  assert.deepEqual(events, ["resource:close"]);
});

test("startup awaits async hooks and shutdown awaits async finalization before releasing resources", async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>(),
    closed = Promise.withResolvers<void>();
  const database = resource({
    async initialize() {
      return {
        value: 42,
        release() {
          events.push("resource:close");
        },
      };
    },
  });
  const start = hook({
    async run() {
      entered.resolve();
      await finish.promise;
      events.push("startup");
    },
  });
  const stop = hook({
    requirements: { database },
    async run({ database }) {
      assert.equal(database, 42);
      closing.resolve();
      await closed.promise;
      events.push("shutdown");
    },
  });
  const starting = runApplication(
    defineApplication({
      modules: [composeModule({ providers: { database } })],
      startupTasks: [start],
      shutdownTasks: [stop],
    }),
  );
  await entered.promise;
  assert.deepEqual(events, []);
  finish.resolve();
  const app = await starting;
  assert.deepEqual(events, ["startup"]);
  const stopping = app.stop();
  await closing.promise;
  assert.deepEqual(events, ["startup"]);
  closed.resolve();
  await stopping;
  assert.deepEqual(events, ["startup", "shutdown", "resource:close"]);
});

test("an aborted signal cancels startup and unwinds what it already acquired", async () => {
  const order: string[] = [];
  const shutdown = new AbortController();
  const tracked = (name: string, onOpen?: () => void) =>
    resource({
      initialize() {
        order.push(`${name}:open`);
        onOpen?.();
        return Promise.resolve({
          value: name,
          release() {
            order.push(`${name}:close`);
          },
        });
      },
    });
  const first = tracked("first", () => shutdown.abort(new Error("interrupted")));
  const second = tracked("second");
  const started = hook({
    run() {
      order.push("startup");
    },
  });
  const module = composeModule({ providers: { first, second } });
  const definition = defineApplication({
    modules: requiredBy(module),
    startupTasks: [started],
  });
  await assert.rejects(runApplication(definition, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual(order, []);
  await assert.rejects(runApplication(definition, { signal: shutdown.signal }), /interrupted/);
  assert.deepEqual(order, ["first:open", "first:close"]);
});

test("aborting the signal of a ready application stops it through the same stop()", async () => {
  const order: string[] = [];
  const shutdown = new AbortController();
  const database = resource({
    initialize() {
      return Promise.resolve({
        value: 1,
        release() {
          order.push("database:close");
        },
      });
    },
  });
  const stopped = hook({
    run() {
      order.push("shutdown");
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: requiredBy(composeModule({ providers: { database } })),
      shutdownTasks: [stopped],
    }),
    { signal: shutdown.signal },
  );
  assert.equal(app.status, "ready");
  shutdown.abort();
  assert.equal(app.status, "stopping");
  await app.stop();
  assert.equal(app.status, "stopped");
  assert.deepEqual(order, ["shutdown", "database:close"]);
});

test("stopOn binds process signals for one run: it unwinds startup or stops a ready application", async () => {
  const order: string[] = [];
  const baseline = process.listenerCount("SIGHUP");
  const tracked = (name: string, onOpen?: () => void) =>
    resource({
      initialize() {
        order.push(`${name}:open`);
        onOpen?.();
        return Promise.resolve({
          value: name,
          release() {
            order.push(`${name}:close`);
          },
        });
      },
    });
  const first = tracked("first", () => process.emit("SIGHUP"));
  const second = tracked("second");
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: requiredBy(composeModule({ providers: { first, second } })),
      }),
      { stopOn: ["SIGHUP"] },
    ),
    /Received SIGHUP/,
  );
  assert.deepEqual(order, ["first:open", "first:close"]);
  assert.equal(process.listenerCount("SIGHUP"), baseline);
  // A graceful stop is a success: the process exit status stays untouched.
  assert.equal(process.exitCode, undefined);

  order.length = 0;
  const database = tracked("database");
  const stoppedTask = hook({
    run() {
      order.push("shutdown");
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: requiredBy(composeModule({ providers: { database } })),
      shutdownTasks: [stoppedTask],
    }),
    { stopOn: ["SIGHUP"] },
  );
  assert.equal(process.listenerCount("SIGHUP"), baseline + 1);
  const status = app.resolve(applicationStatus);
  process.emit("SIGHUP");
  // A signal-initiated stop switches the status synchronously as well.
  assert.equal(status(), "stopping");
  await app.stopped;
  assert.equal(app.status, "stopped");
  assert.equal(app.stop(), app.stopped);
  assert.deepEqual(order, ["database:open", "shutdown", "database:close"]);
  assert.equal(process.listenerCount("SIGHUP"), baseline);
  assert.equal(process.exitCode, undefined);
});

test("a cancelled startup or scope aborts the resource acquisition in progress", async () => {
  const order: string[] = [];
  const first = resource({
    initialize() {
      order.push("first:open");
      return Promise.resolve({
        value: "first",
        release() {
          order.push("first:close");
        },
      });
    },
  });
  // A native connect that honours its signal, as Node.js APIs do: it rejects with the signal's reason.
  const connecting = (cancel: () => void, lifetime: "singleton" | "scoped" = "singleton") =>
    resource({
      lifetime,
      initialize: (_dependencies, { signal }) =>
        new Promise<ResourceHandle<string>>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          order.push("database:connecting");
          cancel();
        }),
    });
  const started = hook({
    run() {
      order.push("startup");
    },
  });
  const starting = (database: ReturnType<typeof connecting>) =>
    defineApplication({
      modules: requiredBy(composeModule({ providers: { first, database } })),
      startupTasks: [started],
    });
  const shutdown = new AbortController();
  await assert.rejects(
    runApplication(starting(connecting(() => shutdown.abort(new Error("interrupted")))), { signal: shutdown.signal }),
    /interrupted/,
  );
  assert.deepEqual(order, ["first:open", "database:connecting", "first:close"]);
  order.length = 0;
  const baseline = process.listenerCount("SIGHUP");
  await assert.rejects(
    runApplication(starting(connecting(() => process.emit("SIGHUP"))), { stopOn: ["SIGHUP"] }),
    /Received SIGHUP/,
  );
  assert.deepEqual(order, ["first:open", "database:connecting", "first:close"]);
  assert.equal(process.listenerCount("SIGHUP"), baseline);

  order.length = 0;
  const request = new AbortController();
  const session = connecting(() => request.abort(new Error("request cancelled")), "scoped");
  let received: AbortSignal | undefined;
  const plain = resource({
    lifetime: "scoped",
    initialize(_dependencies, { signal }) {
      received = signal;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: requiredBy(composeModule({ providers: { session, plain } }).includeOnly([plain])),
    }),
  );
  try {
    let worked = false;
    await assert.rejects(
      app.withScope(
        () => {
          worked = true;
        },
        { resources: [session], signal: request.signal },
      ),
      /request cancelled/,
    );
    assert.equal(worked, false);
    assert.deepEqual(order, ["database:connecting"]);
    // Without a scope signal the acquisition still receives one, which never aborts.
    await app.withScope(() => {});
    assert.ok(received instanceof AbortSignal);
    assert.equal(received.aborted, false);
  } finally {
    await app.stop();
  }
});

test("a scope cancelled while its resources are acquired rejects without running its work and releases them", async () => {
  const request = new AbortController();
  let released = 0;
  // An initializer that completes although the scope was cancelled meanwhile.
  const session = resource({
    lifetime: "scoped",
    async initialize() {
      request.abort(new Error("request cancelled"));
      return {
        value: 1,
        release() {
          released++;
        },
      };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { session } })] }));
  try {
    let worked = false;
    await assert.rejects(
      app.withScope(
        () => {
          worked = true;
        },
        { signal: request.signal },
      ),
      /request cancelled/,
    );
    assert.equal(worked, false);
    assert.equal(released, 1);
  } finally {
    await app.stop();
  }
});

test("a cancelled startup stops waiting for a startup task, and a failure of its own keeps its error", async () => {
  const order: string[] = [];
  const shutdown = new AbortController();
  // A task such as a migration that honours its signal; the shutdown task's signal never aborts.
  const migrate = hook({
    run: (_dependencies, { signal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Migration aborted.", "AbortError")));
        order.push("migrating");
        shutdown.abort(new Error("interrupted"));
      }),
  });
  let shutdownSignal: AbortSignal | undefined;
  const stopped = hook({
    run(_dependencies, { signal }) {
      shutdownSignal = signal;
      order.push("shutdown");
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [], startupTasks: [migrate], shutdownTasks: [stopped] }), {
      signal: shutdown.signal,
    }),
    /interrupted/,
  );
  assert.deepEqual(order, ["migrating", "shutdown"]);
  assert.equal(shutdownSignal?.aborted, false);

  // An acquisition that fails for a reason of its own reports that reason, even while startup is cancelled.
  const cancelled = new AbortController();
  const broken = resource({
    initialize: () => {
      cancelled.abort(new Error("interrupted"));
      return Promise.reject(new Error("authentication failed"));
    },
  });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: requiredBy(composeModule({ providers: { broken } })),
      }),
      { signal: cancelled.signal },
    ),
    /authentication failed/,
  );
});

test("applications of one process share a single listener for each stop signal", async () => {
  const baseline = process.listenerCount("SIGHUP");
  const apps = await Promise.all(
    Array.from({ length: 12 }, () => runApplication(defineApplication({ modules: [] }), { stopOn: ["SIGHUP"] })),
  );
  assert.equal(process.listenerCount("SIGHUP"), baseline + 1);
  process.emit("SIGHUP");
  await Promise.all(apps.map((app) => app.stopped));
  assert.ok(apps.every((app) => app.status === "stopped"));
  assert.equal(process.listenerCount("SIGHUP"), baseline);
  const last = await runApplication(defineApplication({ modules: [] }), { stopOn: ["SIGHUP"] });
  await last.stop();
  assert.equal(process.listenerCount("SIGHUP"), baseline);
});

test("applications stop on SIGINT and SIGTERM by default, and stopOn: [] leaves process signals to the host", async () => {
  const counts = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const baseline = counts();
  const definition = defineApplication({ modules: [] });
  const bound = await runApplication(definition);
  assert.deepEqual(counts(), [baseline[0]! + 1, baseline[1]! + 1]);
  await bound.stop();
  assert.deepEqual(counts(), baseline);
  const hosted = await runApplication(definition, { stopOn: [] });
  assert.deepEqual(counts(), baseline);
  await hosted.stop();
});

test("applicationStatus gives a singleton the live status of its own application through every phase", async () => {
  const seen: string[] = [];
  const observer = unit({ requirements: { applicationStatus }, factory: ({ applicationStatus }) => applicationStatus });
  const database = resource({
    requirements: { observer },
    initialize({ observer }) {
      seen.push(`resource:${observer()}`);
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  const started = hook({
    requirements: { observer },
    run({ observer }) {
      seen.push(`startup:${observer()}`);
    },
  });
  const stopping = hook({
    requirements: { observer },
    run({ observer }) {
      seen.push(`shutdown:${observer()}`);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: requiredBy(composeModule({ providers: { database } })),
      startupTasks: [started],
      shutdownTasks: [stopping],
    }),
  );
  const status = app.resolve(observer);
  assert.equal(status, app.resolve(applicationStatus));
  assert.equal(status(), "ready");
  void app.stop();
  // stop() switches the status synchronously, before any shutdown task runs.
  assert.equal(status(), "stopping");
  await app.stopped;
  assert.equal(status(), "stopped");
  assert.deepEqual(seen, ["resource:starting", "startup:starting", "shutdown:stopping"]);
});

test("applicationStatus is local to each application in the same process", async () => {
  const observer = unit({ requirements: { applicationStatus }, factory: ({ applicationStatus }) => applicationStatus });
  const definition = defineApplication({ modules: [composeModule({ providers: { observer } })] });
  const shutdown = new AbortController();
  const [first, second] = await Promise.all([
    runApplication(definition, { signal: shutdown.signal }),
    runApplication(definition),
  ]);
  try {
    const firstStatus = first.resolve(observer);
    const secondStatus = second.resolve(observer);
    assert.notEqual(firstStatus, secondStatus);
    shutdown.abort();
    assert.equal(firstStatus(), "stopping");
    assert.equal(secondStatus(), "ready");
    await first.stopped;
    assert.equal(firstStatus(), "stopped");
    assert.equal(secondStatus(), "ready");
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

/** An integration like Flow: an entry point that opens execution scopes, and sources that bring work in on their own. */
function integration() {
  const integrated = integratedBy("test:intake", () => adapter);
  const entry = { entry: true, ...integrated } as unknown as Definition;
  const sources = new Map<object, AnyProvider>();
  const adapter: DefinitionAdapter = {
    name: "test:intake",
    adapt: (value) => {
      if (value === entry) {
        return { reference: entry, opensScope: true, provider: unit({ factory: () => "entry" }) };
      }
      const provider = sources.get(value);
      return provider === undefined ? undefined : { reference: value as Definition, source: true, provider };
    },
  };
  const source = (provider: AnyProvider): Definition => {
    const definition = { source: true, ...integrated } as unknown as Definition;
    sources.set(definition, provider);
    return definition;
  };
  return { entry, source };
}

test("intake opens after resources and singletons, before startup tasks, and closes before resources", async () => {
  const events: string[] = [];
  const { entry } = integration();
  const database = resource({
    initialize() {
      events.push("database:open");
      return Promise.resolve({
        value: "db",
        release() {
          events.push("database:close");
        },
      });
    },
  });
  const singleton = unit({
    factory: () => {
      events.push("singleton:build");
      return "singleton";
    },
  });
  // A server: it leads to an execution, and what is built from its value waits for it.
  const server = resource({
    requirements: { database, entry },
    async initialize({ database }) {
      events.push("server:open");
      return {
        value: { url: `http://${database}` },
        release() {
          events.push("server:close");
        },
      };
    },
  });
  const client = unit({
    requirements: { server },
    factory: ({ server }) => {
      events.push("client:build");
      return server;
    },
  });
  const started = hook({
    run() {
      events.push("startup");
    },
  });
  const stopped = hook({
    run() {
      events.push("shutdown");
    },
  });
  const definition = defineApplication({
    modules: [composeModule({ providers: { server, client, singleton } })],
    startupTasks: [started],
    shutdownTasks: [stopped],
  });
  const app = await runApplication(definition);
  assert.equal(app.resolve(client), app.resolve(server));
  assert.equal(app.resolve(server).url, "http://db");
  await app.stop();
  assert.deepEqual(events, [
    "database:open",
    "singleton:build",
    "server:open",
    "client:build",
    "startup",
    "shutdown",
    "server:close",
    "database:close",
  ]);
  const description = await describeApplication(definition);
  assert.deepEqual(description.definitions.find((described) => described.names.includes("server"))?.roles, [
    "root",
    "resource",
    "intake",
  ]);
});

test("sources open before what else leads to an execution and close after it, whatever the module order", async () => {
  const events: string[] = [];
  const { entry, source } = integration();
  const tracked = (name: string) => ({
    async initialize() {
      events.push(`${name}:open`);
      return {
        value: undefined,
        release() {
          events.push(`${name}:close`);
        },
      };
    },
  });
  const http = resource({ requirements: { entry }, ...tracked("http") });
  const admin = resource({ requirements: { entry }, ...tracked("admin") });
  const queue = source(resource(tracked("queue")));
  const timer = source(resource(tracked("timer")));
  const database = resource(tracked("database"));
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({ providers: { http } }),
        composeModule({ providers: { queue, admin } }),
        composeModule({ providers: { timer, database } }),
      ],
    }),
  );
  assert.deepEqual(events, ["database:open", "queue:open", "timer:open", "http:open", "admin:open"]);
  await app.stop();
  assert.deepEqual(events.slice(5), ["admin:close", "http:close", "timer:close", "queue:close", "database:close"]);
});

test("resourceOrder orders what brings work in within its own phase", async () => {
  const events: string[] = [];
  const { entry, source } = integration();
  const tracked = (name: string) => ({
    async initialize() {
      events.push(`${name}:open`);
      return {
        value: undefined,
        release() {
          events.push(`${name}:close`);
        },
      };
    },
  });
  const http = resource({ requirements: { entry }, ...tracked("http") });
  const queue = source(resource(tracked("queue")));
  const database = resource(tracked("database"));
  const cache = resource(tracked("cache"));
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { queue, http, cache, database } })],
      // Listing the server first puts it before the source, but never before an ordinary resource.
      resourceOrder: [http, database],
    }),
  );
  assert.deepEqual(events, ["database:open", "cache:open", "http:open", "queue:open"]);
  await app.stop();
  assert.deepEqual(events.slice(4), ["queue:close", "http:close", "cache:close", "database:close"]);
});

test("a failing or cancelled acquisition closes the intake already open, and an override is never acquired", async () => {
  const events: string[] = [];
  const { entry, source } = integration();
  const queue = source(
    resource({
      async initialize(_dependencies, { signal }) {
        assert.equal(signal.aborted, false);
        events.push("queue:open");
        return {
          value: undefined,
          release() {
            events.push("queue:close");
          },
        };
      },
    }),
  );
  const broken = resource({
    requirements: { entry },
    async initialize(): Promise<ResourceHandle<undefined>> {
      events.push("broken:open");
      throw new Error("port in use");
    },
  });
  const started = hook({
    run() {
      events.push("startup");
    },
  });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { broken, queue } })],
        startupTasks: [started],
      }),
    ),
    /port in use/,
  );
  assert.deepEqual(events, ["queue:open", "broken:open", "queue:close"]);

  events.length = 0;
  const shutdown = new AbortController();
  // The startup signal reaches initialize: a host that waits for a port stops waiting when startup is cancelled.
  const waiting = resource({
    requirements: { entry },
    initialize: (_dependencies, { signal }) =>
      new Promise<ResourceHandle<undefined>>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        events.push("waiting:open");
        shutdown.abort(new Error("interrupted"));
      }),
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { queue, waiting } })] }), {
      signal: shutdown.signal,
    }),
    /interrupted/,
  );
  assert.deepEqual(events, ["queue:open", "waiting:open", "queue:close"]);

  events.length = 0;
  const server = resource({
    requirements: { entry },
    async initialize() {
      events.push("server:open");
      return {
        value: { url: "http://real" },
        release() {
          events.push("server:close");
        },
      };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
    overrides: [override(server, { url: "http://stub" })],
  });
  assert.equal(app.resolve(server).url, "http://stub");
  await app.stop();
  assert.deepEqual(events, []);
});

/** Collects garbage once the current job no longer keeps its objects alive, in the next turn of the event loop. */
async function collect(): Promise<void> {
  const gc = (globalThis as { gc?: (options: object) => void }).gc ?? assert.fail("run with node --expose-gc");
  await new Promise((resolve) => setImmediate(resolve));
  // A full collection: a single regular cycle can leave unreachable objects behind under load.
  gc({ type: "major", execution: "sync", flavor: "last-resort" });
}

test("closed scopes and a stopped application keep nothing they built reachable", async () => {
  const signals = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const before = signals();
  const scoped: WeakRef<object>[] = [];
  let released = 0;
  // Everything the application built is referenced only through it, so it must go once the application has stopped.
  const run = async () => {
    const shared = unit({ factory: () => ({ shared: true }) });
    const request = unit({ lifetime: "scoped", requirements: { shared }, factory: () => ({ request: true }) });
    const session = resource({
      lifetime: "scoped",
      async initialize() {
        return {
          value: { session: true },
          release() {
            released++;
          },
        };
      },
    });
    const app = await runApplication(
      defineApplication({ modules: [composeModule({ providers: { shared, request, session } })] }),
    );
    for (let index = 0; index < 50; index++) {
      await app.withScope((scope) => {
        scoped.push(new WeakRef(scope.resolve(request)), new WeakRef(scope.resolve(session)));
      });
    }
    await collect();
    assert.ok(
      scoped.every((value) => value.deref() === undefined),
      "a closed scope keeps none of its values",
    );
    const built = new WeakRef(app.resolve(shared));
    await app.stop();
    return { application: new WeakRef(app), built };
  };
  const { application, built } = await run();
  await collect();
  assert.equal(released, 50);
  assert.deepEqual(signals(), before);
  assert.equal(built.deref(), undefined, "a stopped application keeps no singleton");
  assert.equal(application.deref(), undefined, "nothing in the process keeps a stopped application");
});

test("scopes that share one long-lived caller signal leave no abort listener on it", async () => {
  const caller = new AbortController();
  const signal = caller.signal;
  let attached = 0;
  const session = resource({
    lifetime: "scoped",
    async initialize(_dependencies, acquisition) {
      attached = Math.max(attached, getEventListeners(signal, "abort").length);
      acquisition.signal.throwIfAborted();
      return { value: { session: true }, release() {} };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { session } })] }), {
    stopOn: [],
  });
  try {
    for (let index = 0; index < 50; index++) {
      await app.withScope((scope) => scope.resolve(session), { signal });
    }
    // Acquisition follows the caller's signal while it runs and detaches once it ends.
    assert.ok(attached > 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally {
    await app.stop();
  }
});

test("aborting the run's signal and calling stop() again while shutdown runs neither cuts it short nor repeats it", async () => {
  const order: string[] = [];
  const run = new AbortController();
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let shutdownSignal: AbortSignal | undefined;
  const database = resource({
    async initialize() {
      return {
        value: 1,
        release() {
          order.push("database:close");
        },
      };
    },
  });
  const flush = hook({
    async run(_dependencies, { signal }) {
      shutdownSignal = signal;
      entered.resolve();
      await proceed.promise;
      order.push("flushed");
    },
  });
  const app = await runApplication(
    defineApplication({ modules: requiredBy(composeModule({ providers: { database } })), shutdownTasks: [flush] }),
    { signal: run.signal, stopOn: [] },
  );
  const first = app.stop();
  await entered.promise;
  run.abort();
  const second = app.stop();
  assert.equal(second, first);
  assert.equal(shutdownSignal?.aborted, false);
  proceed.resolve();
  await first;
  assert.deepEqual(order, ["flushed", "database:close"]);
});

test("applications of one definition started together each acquire and release their own resources once", async () => {
  const acquired: number[] = [];
  const released: number[] = [];
  let next = 0;
  const connection = resource({
    async initialize() {
      const id = ++next;
      acquired.push(id);
      return {
        value: { id },
        release() {
          released.push(id);
        },
      };
    },
  });
  const user = unit({ requirements: { connection }, factory: ({ connection }) => connection.id });
  const definition = defineApplication({ modules: requiredBy(composeModule({ providers: { connection, user } })) });
  const apps = await Promise.all(Array.from({ length: 5 }, () => runApplication(definition, { stopOn: [] })));
  assert.deepEqual(apps.map((app) => app.resolve(user)).sort(), [1, 2, 3, 4, 5]);
  await Promise.all(apps.map((app) => app.stop()));
  assert.deepEqual(acquired.sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(released.sort(), [1, 2, 3, 4, 5]);
});

test("scopes that churn, fail or are cancelled while acquiring release every scoped resource exactly once", async () => {
  const acquired = new Set<number>();
  const released: number[] = [];
  let next = 0;
  const allStarted = Promise.withResolvers<void>();
  const open = Promise.withResolvers<void>();
  const session = resource({
    lifetime: "scoped",
    async initialize(_dependencies, { signal }) {
      const id = ++next;
      if (id === 90) {
        allStarted.resolve();
      }
      // An acquisition that waits on the network, as a pooled connection does, and stops waiting when cancelled.
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        open.promise.then(resolve);
      });
      acquired.add(id);
      return {
        value: id,
        release() {
          released.push(id);
        },
      };
    },
  });
  const app = await runApplication(
    defineApplication({ modules: requiredBy(composeModule({ providers: { session } })) }),
    { stopOn: [] },
  );
  const caller = new AbortController();
  try {
    const runs = Array.from({ length: 90 }, (_, index) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([caller.signal, controller.signal]);
      const run = app.withScope(
        (scope) => {
          scope.resolve(session);
          if (index % 3 === 1) {
            throw new Error("work failed");
          }
          return index;
        },
        { signal },
      );
      return {
        index,
        controller,
        run: run.then(
          () => "done",
          () => "failed",
        ),
      };
    });
    // Every acquisition is waiting; a third of the scopes are cancelled while they wait.
    await allStarted.promise;
    for (const { index, controller } of runs) {
      if (index % 3 === 2) {
        controller.abort(new Error("cancelled"));
      }
    }
    open.resolve();
    const outcomes = await Promise.all(runs.map(({ run }) => run));
    assert.equal(outcomes.filter((outcome) => outcome === "done").length, 30);
    assert.deepEqual(
      released.sort((a, b) => a - b),
      [...acquired].sort((a, b) => a - b),
    );
    assert.equal(new Set(released).size, released.length);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  } finally {
    await app.stop();
  }
});
