import type { CacheChange, CacheLayer } from "../src/index.ts";
import { cache, cacheKey, unsupported } from "../src/index.ts";
import type { Deleted } from "@openknot-ts/behavior";
import { deleted, reader, success } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/behavior/wire";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import type { UowCommitted, Upserted } from "@openknot-ts/flow";
import { command, defaultUnitOfWork, hook, unitOfWork, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { healthProbes } from "@openknot-ts/health";
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import type { ConnectionWatch } from "@openknot-ts/wire";
import type { Definition } from "@openknot-ts/wire";
import { composeModule, defineApplication, override, plug, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
  readonly version: number;
}
const role = (id: string, name: string, version = 1): Role => ({ entity: "role", id, name, version });

/** The layers of a reader as modules list them, given from the outermost one: the first listed is the closest to the source. */
const listed = (...outermostFirst: readonly CacheLayer[]) => [
  // Commits reach the layers in the order their states start, which these tests cover from the outermost one.
  ...outermostFirst.map((layer) => layer.state),
  ...outermostFirst.toReversed().flatMap((layer) => Object.values(layer)),
];

const findRole = reader<(id: string) => Promise<Role | undefined>>();
const saveRole = writer<(value: Role) => Promise<Upserted<Role>>>();
const renameRole = writer<(value: Role) => Promise<Upserted<Role>>>();
const removeRole = writer<(value: Role) => Promise<Deleted<Role>>>();

function fixture(options: { readonly strategy?: "read-through" | "write-through"; readonly failing?: boolean } = {}) {
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  const sourceReads: string[] = [];
  const layer = cache({
    entity: "role",
    strategy: options.strategy ?? "read-through",
    port: findRole,
    writers: saveRole,
    persist: () => (changes: readonly CacheChange[]) => {
      if (options.failing === true) {
        throw new Error("native store unavailable");
      }
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else {
          memory.clear();
        }
      }
    },
    bind: () => ({
      value: (id: string) => {
        if (options.failing === true) {
          throw new Error("native store unavailable");
        }
        return memory.get(id);
      },
    }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => {
      sourceReads.push(id);
      return database.get(id);
    },
  });
  const store = (value: Role) => {
    const stored = { ...value, version: value.version + 1 };
    database.set(value.id, stored);
    return upserted(stored);
  };
  const saves = plug({ port: saveRole, bind: () => async (value: Role) => store(value) });
  const renames = plug({ port: renameRole, bind: () => async (value: Role) => store(value) });
  const removes = plug({
    port: removeRole,
    bind: () => async (value: Role) => {
      database.delete(value.id);
      return deleted(value);
    },
  });
  return {
    database,
    memory,
    sourceReads,
    health: layer.health,
    definitions: [reads, ...listed(layer), saves, renames, removes, layer.health, healthProbes] as readonly object[],
  };
}

async function run(definitions: readonly object[], work: Definition) {
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: [...definitions, work].map((source) => ({ source })) })],
    }),
  );
  return {
    app,
    call: (input?: unknown) => app.withScope((scope) => (scope.resolve(work) as (input?: unknown) => unknown)(input)),
    read: (id: string) => app.withScope((scope) => scope.resolve(findRole)(id)),
  };
}

test("a stopped application keeps none of its cache layers reachable and leaves no timer", async () => {
  const gc = (globalThis as { gc?: (options: object) => void }).gc ?? assert.fail("run with node --expose-gc");
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const before = timers();
  // The ports are module-level and outlive the application, which they must not keep alive.
  const stopped = async () => {
    const state = fixture({ strategy: "write-through" });
    const save = command<Role>()({
      requirements: { saveRole },
      run: async (value, ctx) => success(await ctx.saveRole(value)),
    });
    const { app, call, read } = await run(state.definitions, save);
    for (let index = 0; index < 20; index++) {
      await call(role(`r${index}`, "admin"));
      assert.equal((await read(`r${index}`))?.version, 2);
    }
    await app.stop();
    return new WeakRef(app);
  };
  const application = await stopped();
  // The current job keeps its objects alive until it ends, in the next turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  // A full collection: a single regular cycle can leave unreachable objects behind under load.
  gc({ type: "major", execution: "sync", flavor: "last-resort" });
  assert.equal(application.deref(), undefined);
  assert.equal(timers(), before);
});

test("read-through fills on a miss and answers the next read from the native store", async () => {
  const state = fixture();
  state.database.set("r1", role("r1", "admin"));
  const noop = command({ requirements: {}, run: async () => success(undefined) });
  const { app, read } = await run(state.definitions, noop);
  try {
    assert.equal((await read("r1"))?.name, "admin");
    assert.equal((await read("r1"))?.name, "admin");
    assert.deepEqual(state.sourceReads, ["r1"]);
  } finally {
    await app.stop();
  }
});

test("write-through inserts from listed writers and evicts on other writers", async () => {
  const state = fixture({ strategy: "write-through" });
  const save = command<Role>()({
    requirements: { saveRole },
    run: async (value, ctx) => success(await ctx.saveRole(value)),
  });
  const rename = command<Role>()({
    requirements: { renameRole },
    run: async (value, ctx) => success(await ctx.renameRole(value)),
  });
  const { app, call } = await run([...state.definitions, rename], save);
  try {
    await call(role("r1", "admin", 0));
    assert.equal(state.memory.get("r1")?.name, "admin");
    await app.withScope((scope) => scope.resolve(rename)(role("r1", "root", 1)));
    assert.equal(state.memory.has("r1"), false);
  } finally {
    await app.stop();
  }
});

test("a read of an entity the Unit of Work changed goes to the source", async () => {
  const state = fixture({ strategy: "write-through" });
  const save = command<Role>()({
    requirements: { saveRole, findRole },
    run: async (value, ctx) => {
      await ctx.saveRole(value);
      return success(await ctx.findRole(value.id));
    },
  });
  const { app, call } = await run(state.definitions, save);
  try {
    await call(role("r1", "admin", 0));
    state.sourceReads.length = 0;
    const result = (await call(role("r1", "root", 1))) as { readonly isError: boolean; readonly value?: Role };
    assert.equal(result.value?.name, "root");
    assert.deepEqual(state.sourceReads, ["r1"]);
  } finally {
    await app.stop();
  }
});

test("a failing native store makes the layer unavailable without failing the command, and is reported once", async () => {
  const state = fixture({ strategy: "write-through", failing: true });
  const reports: ErrorReport[] = [];
  const reporter = unit({ provides: errorReporter, factory: () => (report: ErrorReport) => reports.push(report) });
  const save = command<Role>()({
    requirements: { saveRole, findRole },
    run: async (value, ctx) => {
      await ctx.saveRole(value);
      return success(await ctx.findRole(value.id));
    },
  });
  const { app, call, read } = await run([...state.definitions, reporter], save);
  try {
    const result = (await call(role("r1", "admin", 0))) as { readonly isError: boolean };
    assert.equal(result.isError, false);
    assert.equal((await read("r1"))?.name, "admin");
    const health = await app.withScope((scope) => scope.resolve(state.health));
    assert.equal(await health.check({ signal: new AbortController().signal }), "down");
    assert.deepEqual(
      reports.map((report) => [report.source, report.expected, typeof report.attributes?.["openknot.cache.name"]]),
      [["openknot.cache", false, "string"]],
    );
  } finally {
    await app.stop();
  }
});

test("results that are not managed entities are cached by their arguments", async () => {
  const forecast =
    reader<(airport: string) => Promise<{ readonly airport: string; readonly celsius: number } | undefined>>();
  const memory = new Map<string, unknown>();
  const calls: string[] = [];
  const layer = cache({
    port: forecast,
    persist: () => (changes: readonly CacheChange[]) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value);
        }
      }
    },
    bind: () => ({
      value: (airport: string) =>
        memory.get(cacheKey(airport) as string) as { airport: string; celsius: number } | undefined,
    }),
  });
  const forecasts = plug({
    port: forecast,
    bind: () => async (airport: string) => {
      calls.push(airport);
      return { airport, celsius: 21 };
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: [{ source: forecasts }, ...listed(layer).map((source) => ({ source }))] })],
    }),
  );
  try {
    await app.withScope((scope) => scope.resolve(forecast)("ATH"));
    assert.deepEqual(await app.withScope((scope) => scope.resolve(forecast)("ATH")), { airport: "ATH", celsius: 21 });
    assert.deepEqual(calls, ["ATH"]);
  } finally {
    await app.stop();
  }
});

test("a fill that read before a newer commit does not overwrite it", async () => {
  const state = fixture();
  state.database.set("r1", role("r1", "admin", 1));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowRead = reader<(id: string) => Promise<Role | undefined>>();
  const memory = new Map<string, Role>();
  const layer = cache({
    name: "upper-cache",
    entity: "role",
    port: slowRead,
    persist: () => (changes: readonly CacheChange[]) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const slow = plug({
    port: slowRead,
    bind: () => async (id: string) => {
      const value = state.database.get(id);
      await gate;
      return value;
    },
  });
  const save = command<Role>()({
    requirements: { saveRole },
    run: async (value, ctx) => success(await ctx.saveRole(value)),
  });
  const { app, call } = await run([...state.definitions, slow, ...listed(layer)], save);
  try {
    const pending = app.withScope((scope) => scope.resolve(slowRead)("r1"));
    await call(role("r1", "root", 1));
    release();
    await pending;
    assert.equal(memory.get("r1")?.version, 2);
  } finally {
    await app.stop();
  }
});

/** The first commit holds in its afterCommit hook, before its changes reach the cache, until it is released. */
function heldFirstCommit() {
  let entered: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const holdFirst = hook<UowCommitted>()({
    run: async () => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return success();
    },
  });
  const transaction = unitOfWork({ hooks: { afterCommit: [holdFirst] } });
  return {
    held,
    release,
    binding: plug({ port: transaction, bind: () => ({ transaction: (work) => work() }) }),
    selection: unit({
      provides: defaultUnitOfWork,
      lifetime: "scoped",
      requirements: { transaction },
      factory: ({ transaction }) => transaction,
    }),
  };
}

test("a commit applied late does not overwrite a newer commit", async () => {
  const state = fixture({ strategy: "write-through" });
  const commits = heldFirstCommit();
  const save = command<Role>()({
    requirements: { saveRole },
    run: async (value, ctx) => success(await ctx.saveRole(value)),
  });
  const { app, call } = await run([...state.definitions, commits.binding, commits.selection], save);
  try {
    const late = call(role("r1", "admin", 1));
    await commits.held;
    await call(role("r1", "root", 2));
    assert.equal(state.memory.get("r1")?.version, 3);
    commits.release();
    await late;
    assert.equal(state.memory.get("r1")?.name, "root");
  } finally {
    await app.stop();
  }
});

test("a set applied late does not bring back a deleted entity", async () => {
  const state = fixture({ strategy: "write-through" });
  const commits = heldFirstCommit();
  const save = command<Role>()({
    requirements: { saveRole },
    run: async (value, ctx) => success(await ctx.saveRole(value)),
  });
  const remove = command<Role>()({
    requirements: { removeRole },
    run: async (value, ctx) => success(await ctx.removeRole(value)),
  });
  const { app, call } = await run([...state.definitions, commits.binding, commits.selection, remove], save);
  try {
    const late = call(role("r1", "admin", 1));
    await commits.held;
    await app.withScope((scope) => scope.resolve(remove)(role("r1", "admin", 2)));
    commits.release();
    await late;
    assert.equal(state.memory.has("r1"), false);
  } finally {
    await app.stop();
  }
});

test("an asynchronous store holds the committed state before effects run", async () => {
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  const layer = cache({
    entity: "role",
    strategy: "write-through",
    port: findRole,
    writers: saveRole,
    persist: () => (changes: readonly CacheChange[]) =>
      new Promise<void>((resolve) => {
        setImmediate(() => {
          for (const change of changes) {
            if (change.type === "set") {
              memory.set(String(change.key), change.value as Role);
            } else if (change.type === "delete") {
              memory.delete(String(change.key));
            } else {
              memory.clear();
            }
          }
          resolve();
        });
      }),
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => database.get(id),
  });
  const saves = plug({
    port: saveRole,
    bind: () => async (value: Role) => {
      const stored = { ...value, version: value.version + 1 };
      database.set(value.id, stored);
      return upserted(stored);
    },
  });
  let seen: number | undefined;
  const save = command<Role>()({
    requirements: { saveRole },
    run: async (value, ctx) => {
      ctx.uow.afterCommit(() => {
        seen = memory.get(value.id)?.version;
      });
      return success(await ctx.saveRole(value));
    },
  });
  const { app, call } = await run([reads, ...listed(layer), saves, layer.health, healthProbes], save);
  try {
    await call(role("r1", "admin", 1));
    assert.equal(seen, 2);
  } finally {
    await app.stop();
  }
});

test("cacheKey is deterministic and rejects unstable values", () => {
  assert.equal(cacheKey({ a: 1, b: 2 }), cacheKey({ b: 2, a: 1 }));
  assert.notEqual(cacheKey(undefined), cacheKey(null));
  assert.equal(cacheKey(new Map()), undefined);
  assert.equal(cacheKey([new Map()]), undefined);
  const cyclic = { self: null };
  (cyclic as { self: unknown }).self = cyclic;
  assert.equal(cacheKey(cyclic), undefined);
  assert.notEqual(cacheKey(-0), cacheKey(0));
});

test("single-flight is not shared between a Unit of Work and a read outside it", async () => {
  const state = fixture();
  state.database.set("r1", role("r1", "admin"));
  let insideTransaction = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const memory = new Map();
  const sourceReads = [];
  const layer = cache({
    entity: "role",
    strategy: "read-through",
    port: findRole,
    writers: saveRole,
    persist: () => (changes) => {
      for (const c of changes) {
        if (c.type === "set") {
          memory.set(String(c.key), c.value);
        }
      }
    },
    bind: () => ({ value: (id) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id) => {
      const inTx = insideTransaction;
      sourceReads.push(id);
      startedResolve?.();
      startedResolve = undefined;
      await gate;
      return inTx ? undefined : state.database.get(id);
    },
  });
  const save = command({
    requirements: { findRole },
    run: async (_v, ctx) => {
      insideTransaction = true;
      const r = await ctx.findRole("r1");
      insideTransaction = false;
      return success(r);
    },
  });
  const { app } = await run([reads, ...listed(layer), save], save);
  try {
    const pendingCommand = app.withScope((scope) => scope.resolve(save)());
    await started;
    insideTransaction = false;
    const outsidePromise = app.withScope((scope) => scope.resolve(findRole)("r1"));
    release();
    await pendingCommand;
    const outside = (await outsidePromise) as Role | undefined;
    assert.equal(outside?.name, "admin");
    assert.equal(sourceReads.length, 2);
  } finally {
    await app.stop();
  }
});

test("a follower whose leader fails reads the source itself", async () => {
  const state = fixture();
  state.database.set("r1", role("r1", "admin"));
  let sourceCalls = 0;
  let releaseLeader = () => {};
  const leaderGate = new Promise<void>((resolve) => {
    releaseLeader = resolve;
  });
  const memory = new Map();
  const layer = cache({
    entity: "role",
    strategy: "read-through",
    port: findRole,
    writers: saveRole,
    persist: () => (changes) => {
      for (const c of changes) {
        if (c.type === "set") {
          memory.set(String(c.key), c.value);
        }
      }
    },
    bind: () => ({ value: (id) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id) => {
      const n = ++sourceCalls;
      if (n === 1) {
        await leaderGate;
        throw new Error("leader failed");
      }
      return state.database.get(id);
    },
  });
  const noop = command({ requirements: {}, run: async () => success(undefined) });
  const { app } = await run([reads, ...listed(layer)], noop);
  try {
    const firstPromise = app.withScope((scope) => scope.resolve(findRole)("r1"));
    const secondPromise = app.withScope((scope) => scope.resolve(findRole)("r1"));
    releaseLeader();
    const results = await Promise.allSettled([firstPromise, secondPromise]);
    assert.equal(results[0].status, "rejected");
    assert.equal((results[1] as PromiseFulfilledResult<Role | undefined>).value?.name, "admin");
    assert.equal(sourceCalls, 2);
  } finally {
    await app.stop();
  }
});

test("reads within one Unit of Work share one source read", async () => {
  const state = fixture();
  state.database.set("r1", role("r1", "admin"));
  const memory = new Map();
  const sourceReads = [];
  const layer = cache({
    entity: "role",
    strategy: "read-through",
    port: findRole,
    writers: saveRole,
    persist: () => (changes) => {
      for (const c of changes) {
        if (c.type === "set") {
          memory.set(String(c.key), c.value);
        }
      }
    },
    bind: () => ({ value: (id) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => (id) => {
      sourceReads.push(id);
      return Promise.resolve(state.database.get(id));
    },
  });
  const cmd = command({
    requirements: { findRole },
    run: async (_v, ctx) => {
      const both = await Promise.all([ctx.findRole("r1"), ctx.findRole("r1")]);
      return success(both.map((v) => v?.name));
    },
  });
  const { app, call } = await run([reads, ...listed(layer), cmd], cmd);
  try {
    const result = (await call()) as { readonly value?: readonly (string | undefined)[] };
    assert.deepEqual(result.value, ["admin", "admin"]);
    assert.equal(sourceReads.length, 1);
  } finally {
    await app.stop();
  }
});

test("a read inside a Unit of Work after its own write does not reuse an earlier in-flight read", async () => {
  const state = fixture();
  state.database.delete("r1");
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let startedResolve: (() => void) | undefined;
  const memory = new Map();
  const sourceReads = [];
  const layer = cache({
    entity: "role",
    strategy: "write-through",
    port: findRole,
    writers: saveRole,
    persist: () => (changes) => {
      for (const c of changes) {
        if (c.type === "set") {
          memory.set(String(c.key), c.value);
        } else if (c.type === "delete") {
          memory.delete(String(c.key));
        }
      }
    },
    bind: () => ({ value: (id) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id) => {
      sourceReads.push(id);
      startedResolve?.();
      startedResolve = undefined;
      await gate;
      return state.database.get(id);
    },
  });
  const saves = plug({
    port: saveRole,
    bind: () => async (value) => {
      const stored = { ...value, version: value.version + 1 };
      state.database.set(value.id, stored);
      return upserted(stored);
    },
  });
  const cmd = command({
    requirements: { findRole, saveRole },
    run: async (_v, ctx) => {
      const first = ctx.findRole("r1");
      await ctx.saveRole(role("r1", "saved", 0));
      const second = ctx.findRole("r1");
      releaseGate();
      const [, b] = await Promise.all([first, second]);
      return success(b?.name);
    },
  });
  const { app, call } = await run([reads, ...listed(layer), saves, layer.health, cmd], cmd);
  try {
    const result = (await call()) as { readonly value?: string };
    assert.equal(result.value, "saved");
  } finally {
    await app.stop();
  }
});

test("arguments without a stable key bypass the cache and single-flight", async () => {
  const key = new Map();
  const memory = new Map();
  const calls = [];
  const lookup = reader<(value: Map<string, number>) => Promise<number>>();
  const layer = cache({
    port: lookup,
    persist: () => (changes) => {
      for (const c of changes) {
        if (c.type === "set") {
          memory.set(String(c.key), c.value);
        }
      }
    },
    bind: () => ({ value: (value) => memory.get(cacheKey(value)) }),
  });
  const source = plug({
    port: lookup,
    bind: () => async (value) => {
      calls.push(value);
      return 7;
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: [{ source }, layer] })] }));
  try {
    const results = await app.withScope((scope) => {
      const fn = scope.resolve(lookup);
      return Promise.all([fn(key), fn(key)]);
    });
    assert.deepEqual(results, [7, 7]);
    assert.equal(calls.length, 2);
    assert.equal(memory.size, 0);
  } finally {
    await app.stop();
  }
});

function makeConnection(): { readonly conn: ConnectionWatch; lose(): void; restore(): void } {
  let lostHandler: (() => void) | undefined;
  let restoredHandler: (() => void) | undefined;
  const conn: ConnectionWatch = {
    watch(handlers) {
      lostHandler = handlers.lost;
      restoredHandler = handlers.restored;
      return () => undefined;
    },
  };
  return {
    conn,
    lose() {
      lostHandler?.();
    },
    restore() {
      restoredHandler?.();
    },
  };
}

test("a disconnected store sends reads to the source and is cleared and reloaded when the connection is restored", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  const sourceReads: string[] = [];
  const clearCalls: number[] = [];
  const connection = makeConnection();
  const layer = cache({
    entity: "role",
    port: findRole,
    writers: saveRole,
    connection: () => connection.conn,
    persist: () => (changes) => {
      for (const change of changes) {
        if (change.type === "clear") {
          clearCalls.push(1);
          memory.clear();
        } else if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => {
      sourceReads.push(id);
      return database.get(id);
    },
  });
  const saves = plug({
    port: saveRole,
    bind: () => async (value: Role) => {
      const stored = { ...value, version: value.version + 1 };
      database.set(value.id, stored);
      return upserted(stored);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), saves, layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    database.set("r1", role("r1", "admin"));
    const initial = (await app.withScope((scope) => scope.resolve(findRole)("r1"))) as Role | undefined;
    assert.equal(initial?.name, "admin");
    assert.equal(memory.get("r1")?.name, "admin");
    connection.lose();
    sourceReads.length = 0;
    const duringOutage = (await app.withScope((scope) => scope.resolve(findRole)("r1"))) as Role | undefined;
    assert.equal(duringOutage?.name, "admin");
    assert.deepEqual(sourceReads, ["r1"]);
    await app.withScope((scope) => scope.resolve(saveRole)(role("r1", "renamed", 1)));
    assert.equal(memory.get("r1")?.name, "admin");
    connection.restore();
    const recoveringRestore = state().recovering;
    assert.ok(recoveringRestore !== undefined);
    await recoveringRestore;
    assert.equal(clearCalls.length, 1);
    assert.equal(memory.size, 0);
    sourceReads.length = 0;
    const refilled = (await app.withScope((scope) => scope.resolve(findRole)("r1"))) as Role | undefined;
    assert.equal(refilled?.name, "renamed");
    assert.equal(memory.get("r1")?.name, "renamed");
  } finally {
    await app.stop();
  }
});

test("after a store failure the next read recovers the layer", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  let persistCalls = 0;
  const layer = cache({
    entity: "role",
    port: findRole,
    writers: saveRole,
    persist: () => (changes) => {
      persistCalls++;
      if (persistCalls === 1) {
        throw new Error("native store unavailable");
      }
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else if (change.type === "clear") {
          memory.clear();
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => database.get(id),
  });
  const saves = plug({
    port: saveRole,
    bind: () => async (value: Role) => {
      const stored = { ...value, version: value.version + 1 };
      database.set(value.id, stored);
      return upserted(stored);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), saves, layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    database.set("r1", role("r1", "admin"));
    await app.withScope((scope) => scope.resolve(saveRole)(role("r1", "admin", 0)));
    const health = await app.withScope((scope) => scope.resolve(layer.health));
    assert.equal(await health.check({ signal: new AbortController().signal }), "down");
    const readResultPromise = app.withScope((scope) => {
      const value = scope.resolve(findRole)("r1");
      const recoveryPromise = state().recovering;
      return { value, recoveryPromise };
    });
    const readOutcome = await readResultPromise;
    const result = (await readOutcome.value) as Role | undefined;
    assert.equal(result?.name, "admin");
    assert.ok(readOutcome.recoveryPromise !== undefined);
    await readOutcome.recoveryPromise;
    assert.equal(await health.check({ signal: new AbortController().signal }), "up");
  } finally {
    await app.stop();
  }
});

test("a failed recovery leaves the layer down until the next attempt", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  let clearCalls = 0;
  let firstRead = true;
  const layer = cache({
    entity: "role",
    port: findRole,
    persist: () => (changes) => {
      if (changes.length > 0 && changes[0]?.type === "clear") {
        clearCalls++;
        if (clearCalls === 1) {
          throw new Error("clear failed");
        }
      }
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else if (change.type === "clear") {
          memory.clear();
        }
      }
    },
    bind: () => ({
      value: (id: string) => {
        if (firstRead) {
          firstRead = false;
          throw new Error("store unavailable");
        }
        return memory.get(id);
      },
    }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => database.get(id),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    database.set("r1", role("r1", "admin"));
    await app.withScope((scope) => scope.resolve(findRole)("r1"));
    const health = await app.withScope((scope) => scope.resolve(layer.health));
    assert.equal(await health.check({ signal: new AbortController().signal }), "down");
    const secondReadPromise = app.withScope((scope) => {
      const value = scope.resolve(findRole)("r1");
      const recoveryPromise = state().recovering;
      return { value, recoveryPromise };
    });
    const secondOutcome = await secondReadPromise;
    assert.ok(secondOutcome.recoveryPromise !== undefined);
    await secondOutcome.recoveryPromise;
    assert.equal(await health.check({ signal: new AbortController().signal }), "down");
    const thirdReadPromise = app.withScope((scope) => {
      const value = scope.resolve(findRole)("r1");
      const recoveryPromise = state().recovering;
      return { value, recoveryPromise };
    });
    const thirdOutcome = await thirdReadPromise;
    assert.ok(thirdOutcome.recoveryPromise !== undefined);
    await thirdOutcome.recoveryPromise;
    assert.equal(await health.check({ signal: new AbortController().signal }), "up");
  } finally {
    await app.stop();
  }
});

test("a failed snapshot load is retried on the next read", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  let loadCalls = 0;
  let releaseFirstLoad: () => void = () => undefined;
  const firstLoadGate = new Promise<void>((resolve) => {
    releaseFirstLoad = resolve;
  });
  const layer = cache({
    entity: "role",
    strategy: "snapshot",
    port: findRole,
    startup: "background",
    load: async () => {
      loadCalls++;
      if (loadCalls === 1) {
        await firstLoadGate;
        throw new Error("snapshot failed");
      }
      return [role("r1", "admin")];
    },
    persist: () => (changes) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else if (change.type === "clear") {
          memory.clear();
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => database.get(id),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    releaseFirstLoad();
    const firstRecovery = state().recovering;
    assert.ok(firstRecovery !== undefined);
    await firstRecovery;
    const health = await app.withScope((scope) => scope.resolve(layer.health));
    assert.equal(await health.check({ signal: new AbortController().signal }), "down");
    assert.equal(loadCalls, 1);
    const readPromise = app.withScope((scope) => {
      const value = scope.resolve(findRole)("r1");
      const recoveryPromise = state().recovering;
      return { value, recoveryPromise };
    });
    const snapshotOutcome = await readPromise;
    assert.ok(snapshotOutcome.recoveryPromise !== undefined);
    await snapshotOutcome.recoveryPromise;
    assert.equal(loadCalls, 2);
    assert.equal(await health.check({ signal: new AbortController().signal }), "up");
  } finally {
    await app.stop();
  }
});

test("a cache with a connection over a reader plug with a scoped requirement starts", async () => {
  const memory = new Map<string, Role>();
  const connection = makeConnection();
  const scoped = unit({ lifetime: "scoped", factory: () => 1 });
  const layer = cache({
    entity: "role",
    port: findRole,
    connection: () => connection.conn,
    persist: () => (changes) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else if (change.type === "clear") {
          memory.clear();
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    requirements: { scoped },
    bind: () => async (_id: string) => undefined,
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    await app.stop();
  } finally {
  }
});

test("an outage traces once", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  let failing = true;
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  const spans: string[] = [];
  const tracing: Tracing = {
    run: async (span, work) => {
      spans.push(span.name);
      return work();
    },
    capture: () => undefined,
    bind: (work) => work,
  };
  const layer = cache({
    entity: "role",
    port: findRole,
    writers: saveRole,
    persist: () => (changes) => {
      if (failing) {
        throw new Error("native store unavailable");
      }
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else if (change.type === "clear") {
          memory.clear();
        }
      }
    },
    bind: () => ({
      value: (id: string) => {
        if (failing) {
          throw new Error("native store unavailable");
        }
        return memory.get(id);
      },
    }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => database.get(id),
  });
  const noop = command({ requirements: {}, run: async () => success(undefined) });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({ providers: [reads, ...listed(layer), layer.health, noop].map((source) => ({ source })) }),
      ],
    }),
    { overrides: [override(trace, tracing)] },
  );
  try {
    const read = (id: string) => app.withScope((scope) => scope.resolve(findRole)(id));
    database.set("r1", role("r1", "admin"));
    await read("r1");
    await read("r1");
    await read("r1");
    const unavailableSpansAfterFirst = spans.filter((name) => name.includes("unavailable"));
    assert.equal(unavailableSpansAfterFirst.length, 1);
    failing = false;
    const recoveryReadPromise = app.withScope((scope) => {
      const value = scope.resolve(findRole)("r1");
      const recoveryPromise = state().recovering;
      return { value, recoveryPromise };
    });
    const outageOutcome = await recoveryReadPromise;
    assert.ok(outageOutcome.recoveryPromise !== undefined);
    await outageOutcome.recoveryPromise;
    failing = true;
    database.set("r1", role("r1", "admin"));
    await read("r1");
    await read("r1");
    await read("r1");
    const unavailableSpansTotal = spans.filter((name) => name.includes("unavailable"));
    assert.equal(unavailableSpansTotal.length, 2);
  } finally {
    await app.stop();
  }
});

test("losing the connection twice in a row does not start a second recovery", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  const connection = makeConnection();
  const layer = cache({
    entity: "role",
    port: findRole,
    connection: () => connection.conn,
    persist: () => (changes) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else if (change.type === "clear") {
          memory.clear();
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => database.get(id),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    database.set("r1", role("r1", "admin"));
    await app.withScope((scope) => scope.resolve(findRole)("r1"));
    connection.lose();
    connection.lose();
    connection.restore();
    const recoveringDouble = state().recovering;
    assert.ok(recoveringDouble !== undefined);
    await recoveringDouble;
    const health = await app.withScope((scope) => scope.resolve(layer.health));
    assert.equal(await health.check({ signal: new AbortController().signal }), "up");
  } finally {
    await app.stop();
  }
});

test("restore without a prior lose does not break the layer", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  const connection = makeConnection();
  const memory = new Map<string, Role>();
  const database = new Map<string, Role>();
  const layer = cache({
    entity: "role",
    port: findRole,
    connection: () => connection.conn,
    persist: () => (changes) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => database.get(id),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    connection.restore();
    const recoveringRestore = state().recovering;
    assert.ok(recoveringRestore !== undefined);
    await recoveringRestore;
    const health = await app.withScope((scope) => scope.resolve(layer.health));
    assert.equal(await health.check({ signal: new AbortController().signal }), "up");
  } finally {
    await app.stop();
  }
});

test("a read while a recovery is in flight reaches the source and starts no second recovery", async () => {
  type LayerHandle = { readonly recovering: Promise<void> | undefined };
  const state = () => app.resolve(layer.state as NonNullable<typeof layer.state>) as LayerHandle;
  const database = new Map<string, Role>();
  const memory = new Map<string, Role>();
  const clearCalls: number[] = [];
  let releaseClearGate: () => void = () => undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClearGate = resolve;
  });
  const connection = makeConnection();
  const layer = cache({
    entity: "role",
    port: findRole,
    connection: () => connection.conn,
    persist: () => async (changes) => {
      for (const change of changes) {
        if (change.type === "clear") {
          clearCalls.push(1);
          await clearGate;
        } else if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => {
      database.set(id, role(id, "admin"));
      return database.get(id);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [reads, ...listed(layer), layer.health, healthProbes].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    connection.lose();
    connection.restore();
    const result = (await app.withScope((scope) => scope.resolve(findRole)("r1"))) as Role | undefined;
    assert.equal(result?.name, "admin");
    const inFlightClearRecovery = state().recovering;
    assert.ok(inFlightClearRecovery !== undefined);
    releaseClearGate();
    await inFlightClearRecovery;
    assert.ok(clearCalls.length <= 1);
  } finally {
    await app.stop();
  }
});

function flightGate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { entered: entered.promise, enter: entered.resolve, wait: released.promise, release: released.resolve };
}

function flightFixture(strategy: "read-through" | "write-through" = "read-through") {
  const database = new Map([["r1", role("r1", "old")]]);
  const memory = new Map<string, Role>();
  const listRoles = reader<() => Promise<readonly Role[]>>();
  const ports = reader.compose({ byId: findRole, list: listRoles });
  const holds: ReturnType<typeof flightGate>[] = [];
  const sourceReads: unknown[] = [];
  let observed: (() => void) | undefined;
  let storeHold: ReturnType<typeof flightGate> | undefined;
  let storeReadFails = false;
  const nativeRead = () => {
    observed?.();
    observed = undefined;
  };
  const capture = async <T>(value: T): Promise<T> => {
    sourceReads.push(value);
    const hold = holds.shift();
    if (hold !== undefined) {
      hold.enter();
      await hold.wait;
    }
    return value;
  };
  const layer = cache({
    entity: "role",
    strategy,
    port: ports,
    writers: saveRole,
    persist: () => async (changes) => {
      const hold = storeHold;
      storeHold = undefined;
      if (hold !== undefined) {
        hold.enter();
        await hold.wait;
      }
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else {
          memory.clear();
        }
      }
    },
    bind: () => ({
      byId: (id) => {
        nativeRead();
        if (storeReadFails) {
          storeReadFails = false;
          throw new Error("native store unavailable");
        }
        return memory.get(id);
      },
      list: () => {
        nativeRead();
        return undefined;
      },
    }),
  });
  const reads = plug({
    port: ports,
    bind: () => ({
      byId: (id) => capture(database.get(id)),
      list: () => capture([...database.values()]),
    }),
  });
  const store = async (value: Role) => {
    const stored = { ...value, version: value.version + 1 };
    database.set(value.id, stored);
    return upserted(stored);
  };
  const saves = plug({ port: saveRole, bind: () => store });
  const renames = plug({ port: renameRole, bind: () => store });
  const removes = plug({
    port: removeRole,
    bind: () => async (value) => {
      database.delete(value.id);
      return deleted(value);
    },
  });
  return {
    database,
    memory,
    listRoles,
    sourceReads,
    definitions: [reads, ...listed(layer), saves, renames, removes],
    layer,
    failNextStoreRead() {
      storeReadFails = true;
    },
    holdSource() {
      const hold = flightGate();
      holds.push(hold);
      return hold;
    },
    holdStore() {
      const hold = flightGate();
      storeHold = hold;
      return hold;
    },
    observeRead() {
      const seen = Promise.withResolvers<void>();
      observed = seen.resolve;
      return seen.promise;
    },
  };
}

test("an inserted row is visible after an earlier flight captured absence", { timeout: 10_000 }, async () => {
  const state = flightFixture();
  const hold = state.holdSource();
  const work = command({
    requirements: { findRole, saveRole },
    run: async (_, ctx) => {
      const first = ctx.findRole("r9");
      await hold.entered;
      await ctx.saveRole(role("r9", "saved", 0));
      const observed = state.observeRead();
      const second = ctx.findRole("r9");
      await observed;
      hold.release();
      return success((await Promise.all([first, second])).map((value) => value?.name));
    },
  });
  const { app } = await run(state.definitions, work);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(work)()), success([undefined, "saved"]));
    assert.equal(state.sourceReads.length, 2);
  } finally {
    hold.release();
    await app.stop();
  }
});

test("a transaction list includes an insert absent from its earlier flight", { timeout: 10_000 }, async () => {
  const state = flightFixture();
  const hold = state.holdSource();
  const work = command({
    requirements: { listRoles: state.listRoles, saveRole },
    run: async (_, ctx) => {
      const first = ctx.listRoles();
      await hold.entered;
      await ctx.saveRole(role("r2", "editor", 0));
      const observed = state.observeRead();
      const second = ctx.listRoles();
      await observed;
      hold.release();
      return success((await Promise.all([first, second])).map((values) => values.map((value) => value.id)));
    },
  });
  const { app } = await run(state.definitions, work);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(work)()), success([["r1"], ["r1", "r2"]]));
    assert.equal(state.sourceReads.length, 2);
  } finally {
    hold.release();
    await app.stop();
  }
});

for (const scenario of ["delete", "unlisted update"] as const) {
  test(`an outside read after a committed ${scenario} rejects the old flight`, { timeout: 10_000 }, async () => {
    const state = flightFixture("write-through");
    const hold = state.holdSource();
    const work = command({
      requirements: { removeRole, renameRole },
      run: async (_, ctx) => {
        if (scenario === "delete") {
          await ctx.removeRole(role("r1", "old"));
        } else {
          await ctx.renameRole(role("r1", "new"));
        }
        return success();
      },
    });
    const { app, read } = await run(state.definitions, work);
    try {
      const first = read("r1");
      await hold.entered;
      assert.deepEqual(await app.withScope((scope) => scope.resolve(work)()), success());
      const observed = state.observeRead();
      const second = read("r1");
      await observed;
      hold.release();
      const [before, after] = await Promise.all([first, second]);
      assert.equal(before?.name, "old");
      assert.equal(after?.name, scenario === "delete" ? undefined : "new");
      assert.equal((await read("r1"))?.name, scenario === "delete" ? undefined : "new");
      assert.equal(state.memory.get("r1")?.name, scenario === "delete" ? undefined : "new");
    } finally {
      hold.release();
      await app.stop();
    }
  });
}

test("an effect read rejects a flight captured before deletion", { timeout: 10_000 }, async () => {
  const state = flightFixture();
  const hold = state.holdSource();
  const store = state.holdStore();
  let seen: Role | undefined;
  let effectRan = false;
  let returned = false;
  const work = command({
    requirements: { findRole, removeRole },
    run: async (_, ctx) => {
      ctx.uow.afterCommit(async () => {
        effectRan = true;
        const observed = state.observeRead();
        const pending = ctx.findRole("r1");
        await observed;
        hold.release();
        seen = await pending;
      });
      await ctx.removeRole(role("r1", "old"));
      return success();
    },
  });
  const { app, read } = await run(state.definitions, work);
  try {
    const first = read("r1");
    await hold.entered;
    const pending = app
      .withScope((scope) => scope.resolve(work)())
      .then((result) => {
        returned = true;
        return result;
      });
    await store.entered;
    assert.equal(effectRan, false);
    assert.equal(returned, false);
    store.release();
    assert.deepEqual(await pending, success());
    await first;
    assert.equal(effectRan, true);
    assert.equal(seen, undefined);
    assert.equal(state.memory.has("r1"), false);
  } finally {
    store.release();
    hold.release();
    await app.stop();
  }
});

test("a transaction follower rechecks a touched row written after it joined", { timeout: 10_000 }, async () => {
  const state = flightFixture();
  const hold = state.holdSource();
  const work = command({
    requirements: { findRole, saveRole },
    run: async (_, ctx) => {
      const first = ctx.findRole("r1");
      await hold.entered;
      const observed = state.observeRead();
      const second = ctx.findRole("r1");
      await observed;
      await ctx.saveRole(role("r1", "new"));
      hold.release();
      return success((await Promise.all([first, second])).map((value) => value?.name));
    },
  });
  const { app } = await run(state.definitions, work);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(work)()), success(["old", "new"]));
    assert.equal(state.sourceReads.length, 2);
  } finally {
    hold.release();
    await app.stop();
  }
});

test("outside misses without a commit share one captured source read", { timeout: 10_000 }, async () => {
  const state = flightFixture();
  const hold = state.holdSource();
  const noop = command({ run: async () => success() });
  const { app, read } = await run(state.definitions, noop);
  try {
    const first = read("r1");
    await hold.entered;
    const observed = state.observeRead();
    const second = read("r1");
    await observed;
    hold.release();
    assert.deepEqual(await Promise.all([first, second]), [role("r1", "old"), role("r1", "old")]);
    assert.equal(state.sourceReads.length, 1);
  } finally {
    hold.release();
    await app.stop();
  }
});

test("a listed writer fences old fills while its asynchronous store is pending", { timeout: 10_000 }, async () => {
  const state = flightFixture("write-through");
  const hold = state.holdSource();
  const store = state.holdStore();
  const work = command({
    requirements: { saveRole },
    run: async (_, ctx) => success(await ctx.saveRole(role("r1", "new"))),
  });
  const { app, read } = await run(state.definitions, work);
  try {
    const first = read("r1");
    await hold.entered;
    const pending = app.withScope((scope) => scope.resolve(work)());
    await store.entered;
    const observed = state.observeRead();
    const second = read("r1");
    await observed;
    hold.release();
    const [, after] = await Promise.all([first, second]);
    store.release();
    assert.equal((await pending).isError, false);
    assert.equal(after?.name, "new");
    assert.equal(state.memory.get("r1")?.name, "new");
  } finally {
    store.release();
    hold.release();
    await app.stop();
  }
});

test("settling an old flight preserves sharing of its replacement", { timeout: 10_000 }, async () => {
  const state = flightFixture();
  const old = state.holdSource();
  const work = command({
    requirements: { removeRole },
    run: async (_, ctx) => success(await ctx.removeRole(role("r1", "old"))),
  });
  const { app, read } = await run(state.definitions, work);
  const fresh = state.holdSource();
  try {
    const first = read("r1");
    await old.entered;
    assert.equal((await app.withScope((scope) => scope.resolve(work)())).isError, false);
    const secondObserved = state.observeRead();
    const second = read("r1");
    await secondObserved;
    old.release();
    await first;
    const thirdObserved = state.observeRead();
    const third = read("r1");
    await thirdObserved;
    fresh.release();
    assert.deepEqual(await Promise.all([second, third]), [undefined, undefined]);
    assert.equal(state.sourceReads.length, 2);
    assert.equal(state.memory.has("r1"), false);
  } finally {
    old.release();
    fresh.release();
    await app.stop();
  }
});

test("a commit skipped by an unavailable store still retires the outside flight", { timeout: 10_000 }, async () => {
  const state = flightFixture();
  const hold = state.holdSource();
  const work = command({
    requirements: { removeRole },
    run: async (_, ctx) => success(await ctx.removeRole(role("r1", "old"))),
  });
  const { app, read } = await run(state.definitions, work);
  try {
    const first = read("r1");
    await hold.entered;
    state.failNextStoreRead();
    await read("r2");
    assert.equal((await app.withScope((scope) => scope.resolve(work)())).isError, false);
    const handle = app.resolve(state.layer.state as NonNullable<typeof state.layer.state>);
    await (handle as { readonly recovering: Promise<void> | undefined }).recovering;
    const observed = state.observeRead();
    const second = read("r1");
    await observed;
    hold.release();
    const [before, after] = await Promise.all([first, second]);
    assert.equal(before?.name, "old");
    assert.equal(after, undefined);
    assert.equal(state.memory.has("r1"), false);
  } finally {
    hold.release();
    await app.stop();
  }
});

test("a result cache keeps sharing its flight across a recovery", { timeout: 10_000 }, async () => {
  const forecast = reader<(airport: string) => Promise<number>>();
  const hold = flightGate();
  const calls: string[] = [];
  let storeFails = false;
  let onStoreRead = () => {};
  const layer = cache({
    port: forecast,
    persist: () => () => undefined,
    bind: () => ({
      value: (_airport: string) => {
        onStoreRead();
        if (!storeFails) {
          return undefined;
        }
        storeFails = false;
        throw new Error("native store unavailable");
      },
    }),
  });
  const forecasts = plug({
    port: forecast,
    bind: () => async (airport: string) => {
      calls.push(airport);
      if (airport === "ATH") {
        hold.enter();
        await hold.wait;
      }
      return 21;
    },
  });
  const noop = command({ run: async () => success() });
  const { app } = await run([forecasts, ...listed(layer)], noop);
  const read = (airport: string) => app.withScope((scope) => scope.resolve(forecast)(airport));
  try {
    const leader = read("ATH");
    await hold.entered;
    storeFails = true;
    await read("SKG");
    await read("SKG");
    const handle = app.resolve(layer.state as NonNullable<typeof layer.state>);
    await (handle as { readonly recovering: Promise<void> | undefined }).recovering;
    const seen = Promise.withResolvers<void>();
    onStoreRead = seen.resolve;
    const follower = read("ATH");
    await seen.promise;
    hold.release();
    assert.deepEqual(await Promise.all([leader, follower]), [21, 21]);
    assert.deepEqual(
      calls.filter((airport) => airport === "ATH"),
      ["ATH"],
    );
  } finally {
    hold.release();
    await app.stop();
  }
});

interface Log {
  readonly entity: "log";
  readonly id: string;
  readonly version: number;
}
const saveLog = writer<(value: Log) => Promise<Upserted<Log>>>();

function stackFixture(
  names: readonly string[],
  options: {
    readonly belowFirst?: boolean;
    readonly unsupported?: boolean;
    readonly connection?: ConnectionWatch;
    readonly snapshotTop?: boolean;
  } = {},
) {
  const database = new Map([["r1", role("r1", "old")]]);
  const failingStoreReads = new Set<string>();
  const { connection } = options;
  const stores = new Map<string, Map<string, Role>>();
  const delivery: string[] = [];
  const sourceHolds: ReturnType<typeof flightGate>[] = [];
  const persistHolds = new Map<string, ReturnType<typeof flightGate>>();
  const storeHolds = new Map<string, ReturnType<typeof flightGate>>();
  let sourceCalls = 0;
  let awaitedStoreRead: (() => void) | undefined;
  const layers: ReturnType<typeof cache>[] = [];
  for (const name of [...names].reverse()) {
    const memory = new Map<string, Role>();
    stores.set(name, memory);
    const below = layers[0];
    const layer = cache({
      name,
      entity: "role",
      port: findRole,
      ...(options.snapshotTop === true && name === names[0]
        ? { strategy: "snapshot" as const, startup: "blocking" as const, load: () => [] }
        : { strategy: "write-through" as const }),
      ...(connection !== undefined && name === names[0] ? { connection: () => connection } : {}),
      // An upper layer that requires the one below it starts later, and so receives commits later.
      requirements:
        options.belowFirst === true && below !== undefined
          ? { below: below.state as NonNullable<typeof below.state> }
          : {},
      persist: () => async (changes: readonly CacheChange[]) => {
        // These stacks list no writers, so a commit only deletes and a fill only sets.
        if (changes.some((change) => change.type === "delete") && !delivery.includes(name)) {
          delivery.push(name);
        }
        const hold = persistHolds.get(name);
        persistHolds.delete(name);
        if (hold !== undefined) {
          hold.enter();
          await hold.wait;
        }
        for (const change of changes) {
          if (change.type === "set") {
            memory.set(String(change.key), change.value as Role);
          } else if (change.type === "delete") {
            memory.delete(String(change.key));
          } else {
            memory.clear();
          }
        }
      },
      bind: () => ({
        value: (id: string) => {
          awaitedStoreRead?.();
          awaitedStoreRead = undefined;
          if (failingStoreReads.delete(name)) {
            throw new Error("native store unavailable");
          }
          if (options.unsupported === true) {
            return unsupported();
          }
          const value = memory.get(id);
          const hold = storeHolds.get(name);
          if (hold === undefined) {
            return value;
          }
          storeHolds.delete(name);
          hold.enter();
          return hold.wait.then(() => value);
        },
      }),
    });
    layers.unshift(layer);
  }
  const reads = plug({
    port: findRole,
    bind: () => async (id: string) => {
      sourceCalls++;
      const value = database.get(id);
      const hold = sourceHolds.shift();
      if (hold !== undefined) {
        hold.enter();
        await hold.wait;
      }
      return value;
    },
  });
  const store = async (value: Role) => {
    const stored = { ...value, version: value.version + 1 };
    database.set(value.id, stored);
    return upserted(stored);
  };
  const writers = [
    plug({ port: saveRole, bind: () => store }),
    plug({ port: renameRole, bind: () => store }),
    plug({
      port: removeRole,
      bind: () => async (value: Role) => {
        database.delete(value.id);
        return deleted(value);
      },
    }),
    plug({ port: saveLog, bind: () => async (value: Log) => upserted({ ...value, version: value.version + 1 }) }),
  ];
  return {
    stores,
    delivery,
    layers,
    definitions: [reads, ...listed(...layers), ...writers],
    failNextStoreRead(name: string) {
      failingStoreReads.add(name);
    },
    sourceCalls: () => sourceCalls,
    holdSource() {
      const hold = flightGate();
      sourceHolds.push(hold);
      return hold;
    },
    holdPersist(name: string) {
      const hold = flightGate();
      persistHolds.set(name, hold);
      return hold;
    },
    holdStoreRead(name: string) {
      const hold = flightGate();
      storeHolds.set(name, hold);
      return hold;
    },
    /** Resolves once the next read has passed its stores, which answer synchronously unless a store read is held. */
    nextStoreRead() {
      const seen = Promise.withResolvers<void>();
      awaitedStoreRead = seen.resolve;
      return seen.promise;
    },
  };
}

const stackWrites = {
  delete: { input: role("r1", "old"), expected: undefined },
  "unlisted update": { input: role("r1", "new"), expected: "new" },
} as const;

function stackWork(
  write: keyof typeof stackWrites,
  effect?: (read: (id: string) => Promise<Role | undefined>) => Promise<void>,
) {
  return command({
    requirements: { findRole, removeRole, renameRole },
    run: async (_, ctx) => {
      if (effect !== undefined) {
        ctx.uow.afterCommit(() => effect((id) => ctx.findRole(id)));
      }
      if (write === "delete") {
        await ctx.removeRole(stackWrites[write].input);
      } else {
        await ctx.renameRole(stackWrites[write].input);
      }
      return success();
    },
  });
}

const stacks: readonly {
  readonly names: readonly string[];
  readonly held: string;
  readonly writes?: readonly (keyof typeof stackWrites)[];
  readonly belowFirst?: boolean;
  readonly quiet?: boolean;
}[] = [
  { names: ["top", "bottom"], held: "top", writes: ["delete", "unlisted update"] },
  { names: ["top"], held: "top" },
  { names: ["top", "bottom"], held: "bottom" },
  { names: ["top", "bottom"], held: "top", quiet: true },
  { names: ["top", "bottom"], held: "top", belowFirst: true },
  { names: ["top", "bottom"], held: "bottom", belowFirst: true },
  { names: ["top", "middle", "bottom"], held: "middle" },
];

for (const { names, held, writes, belowFirst = false, quiet = false } of stacks) {
  for (const write of writes ?? (["delete"] as const)) {
    const { expected } = stackWrites[write];
    const label = [
      names.join("/"),
      held + " persist held",
      belowFirst ? "lowest layer first" : "listed order",
      quiet ? "no read during persist" : "a read during persist",
      write,
    ].join(", ");

    /** A leader reads the old row, the command commits over it, and one read may start during the held store write. */
    async function overlap(
      state: ReturnType<typeof stackFixture>,
      leaderHold: ReturnType<typeof flightGate>,
      work: ReturnType<typeof stackWork>,
    ) {
      const persist = state.holdPersist(held);
      const { app, read } = await run(state.definitions, work);
      const leader = read("r1");
      await leaderHold.entered;
      const pending = app.withScope((scope) => scope.resolve(work)());
      await persist.entered;
      let during: Promise<Role | undefined> = Promise.resolve(undefined);
      if (!quiet) {
        const seen = state.nextStoreRead();
        during = read("r1");
        await seen;
      }
      persist.release();
      return { app, read, leader, during, outcome: await pending };
    }
    function assertSettled(state: ReturnType<typeof stackFixture>) {
      assert.deepEqual(state.delivery, belowFirst ? [...names].reverse() : names);
      for (const name of names) {
        assert.notEqual(state.stores.get(name)?.get("r1")?.name, "old");
      }
    }

    test(label + ": a read after the command returned sees the commit", { timeout: 10_000 }, async () => {
      const state = stackFixture(names, { belowFirst });
      const leaderHold = state.holdSource();
      const { app, read, leader, during, outcome } = await overlap(state, leaderHold, stackWork(write));
      try {
        assert.equal(outcome.isError, false);
        const seen = state.nextStoreRead();
        const after = read("r1");
        await seen;
        leaderHold.release();
        const [, duringValue, value] = await Promise.all([leader, during, after]);
        assert.equal(value?.name, expected);
        if (!quiet) {
          assert.equal(duringValue?.name, expected);
        }
        assertSettled(state);
      } finally {
        leaderHold.release();
        await app.stop();
      }
    });

    test(label + ": an effect read sees the commit", { timeout: 10_000 }, async () => {
      const state = stackFixture(names, { belowFirst });
      const leaderHold = state.holdSource();
      let effectRead: string | undefined = "not run";
      const work = stackWork(write, async (readInEffect) => {
        const seen = state.nextStoreRead();
        const reading = readInEffect("r1");
        await seen;
        leaderHold.release();
        effectRead = (await reading)?.name;
      });
      const { app, leader, during, outcome } = await overlap(state, leaderHold, work);
      try {
        assert.equal(outcome.isError, false);
        const [, duringValue] = await Promise.all([leader, during]);
        assert.equal(effectRead, expected);
        if (!quiet) {
          assert.equal(duringValue?.name, expected);
        }
        assertSettled(state);
      } finally {
        await app.stop();
      }
    });
  }
}

for (const write of ["delete", "unlisted update"] as const) {
  test(
    "a store read overlapping the lower persist does not outlive the command, " + write,
    {
      timeout: 10_000,
    },
    async () => {
      const names = ["top", "bottom"];
      const state = stackFixture(names);
      state.stores.get("bottom")?.set("r1", role("r1", "old"));
      const persist = state.holdPersist("bottom");
      const storeRead = state.holdStoreRead("bottom");
      const work = stackWork(write);
      const { app, read } = await run(state.definitions, work);
      try {
        const pending = app.withScope((scope) => scope.resolve(work)());
        await persist.entered;
        const during = read("r1");
        await storeRead.entered;
        persist.release();
        assert.equal((await pending).isError, false);
        const seen = state.nextStoreRead();
        const after = read("r1");
        await seen;
        storeRead.release();
        const [, value] = await Promise.all([during, after]);
        assert.equal(value?.name, stackWrites[write].expected);
        for (const name of names) {
          assert.notEqual(state.stores.get(name)?.get("r1")?.name, "old");
        }
      } finally {
        persist.release();
        storeRead.release();
        await app.stop();
      }
    },
  );
}

for (const [outage, write, snapshotTop] of [
  ["a failed store read", "delete", false],
  ["a failed store read", "unlisted update", false],
  ["a lost connection", "delete", false],
  ["a failed store read", "delete", true],
] as const) {
  test(
    "an upper layer down at the commit through " +
      outage +
      " does not keep a lower old entry, " +
      write +
      (snapshotTop ? ", a partial snapshot on top" : ""),
    {
      timeout: 10_000,
    },
    async () => {
      const connection = makeConnection();
      const names = ["top", "bottom"];
      const state = stackFixture(names, {
        snapshotTop,
        ...(outage === "a lost connection" ? { connection: connection.conn } : {}),
      });
      const [top] = state.layers;
      assert.ok(top !== undefined);
      for (const name of names) {
        state.stores.get(name)?.set("r1", role("r1", "old"));
      }
      let effectRead: string | undefined = "not run";
      const work = stackWork(write, async (readInEffect) => {
        effectRead = (await readInEffect("r1"))?.name;
      });
      const persist = state.holdPersist("bottom");
      const { app, read } = await run(state.definitions, work);
      const handle = app.resolve(top.state as NonNullable<typeof top.state>);
      try {
        if (outage === "a lost connection") {
          connection.lose();
        } else {
          state.failNextStoreRead("top");
          await read("r2");
        }
        const pending = app.withScope((scope) => scope.resolve(work)());
        await persist.entered;
        if (outage === "a lost connection") {
          connection.restore();
        }
        await (handle as { readonly recovering: Promise<void> | undefined }).recovering;
        await read("r1");
        persist.release();
        assert.equal((await pending).isError, false);
        const { expected } = stackWrites[write];
        assert.equal((await read("r1"))?.name, expected);
        assert.equal(effectRead, expected);
        for (const name of names) {
          assert.notEqual(state.stores.get(name)?.get("r1")?.name, "old");
        }
      } finally {
        persist.release();
        await app.stop();
      }
    },
  );
}

for (const write of ["delete", "update"] as const) {
  for (const down of [false, true]) {
    const label = write + (down ? ", the upper layer down at the commit" : ", every layer up");
    test(
      "a fill of an unordered state from a lower store does not outlive its commit, " + label,
      {
        timeout: 10_000,
      },
      async () => {
        interface Note {
          readonly entity: "note";
          readonly id: string;
          readonly name: string;
        }
        const findNote = reader<(id: string) => Promise<Note | undefined>>();
        const removeNote = writer<(value: Note) => Promise<Deleted<Note>>>();
        const updateNote = writer<(value: Note) => Promise<Upserted<Note>>>();
        const old: Note = { entity: "note", id: "n1", name: "old" };
        const database = new Map([["n1", old]]);
        const persist = flightGate();
        let storeReadFails = down;
        const memories = { top: new Map(down ? [["n1", old]] : []), bottom: new Map([["n1", old]]) };
        const layerOf = (name: "top" | "bottom") =>
          cache({
            name,
            entity: "note",
            port: findNote,
            persist: () => async (changes: readonly CacheChange[]) => {
              if (name === "bottom") {
                persist.enter();
                await persist.wait;
              }
              for (const change of changes) {
                if (change.type === "set") {
                  memories[name].set(String(change.key), change.value as Note);
                } else if (change.type === "delete") {
                  memories[name].delete(String(change.key));
                } else {
                  memories[name].clear();
                }
              }
            },
            bind: () => ({
              value: (id: string) => {
                if (name === "top" && storeReadFails) {
                  storeReadFails = false;
                  throw new Error("native store unavailable");
                }
                return memories[name].get(id);
              },
            }),
          });
        const top = layerOf("top");
        const reads = plug({
          port: findNote,
          bind: () => async (id: string) => database.get(id),
        });
        const writers = [
          plug({
            port: removeNote,
            bind: () => async (value: Note) => {
              database.delete(value.id);
              return deleted(value);
            },
          }),
          plug({
            port: updateNote,
            bind: () => async (value: Note) => {
              database.set(value.id, value);
              return upserted(value);
            },
          }),
        ];
        const work = command({
          requirements: { removeNote, updateNote },
          run: async (_, ctx) => {
            if (write === "delete") {
              await ctx.removeNote(old);
            } else {
              await ctx.updateNote({ ...old, name: "new" });
            }
            return success();
          },
        });
        const { app } = await run([reads, ...listed(top, layerOf("bottom")), ...writers], work);
        const read = (id: string) => app.withScope((scope) => scope.resolve(findNote)(id));
        const handle = app.resolve(top.state as NonNullable<typeof top.state>);
        try {
          if (down) {
            await read("n2");
          }
          const pending = app.withScope((scope) => scope.resolve(work)());
          await persist.entered;
          await (handle as { readonly recovering: Promise<void> | undefined }).recovering;
          await read("n1");
          persist.release();
          assert.equal((await pending).isError, false);
          assert.notEqual(memories.top.get("n1")?.name, "old");
          const expected = write === "delete" ? undefined : "new";
          assert.equal((await read("n1"))?.name, expected);
          // The commit's bookkeeping has ended, so a later fill is kept again.
          assert.equal(memories.top.get("n1")?.name, expected);
        } finally {
          persist.release();
          await app.stop();
        }
      },
    );
  }
}

test(
  "a read after the transaction's own write bypasses the flight when the store answers unsupported",
  {
    timeout: 10_000,
  },
  async () => {
    const state = stackFixture(["top"], { unsupported: true });
    const hold = state.holdSource();
    const work = command({
      requirements: { findRole, saveRole },
      run: async (_, ctx) => {
        const first = ctx.findRole("r9");
        await hold.entered;
        await ctx.saveRole(role("r9", "saved", 0));
        const seen = state.nextStoreRead();
        const second = ctx.findRole("r9");
        await seen;
        hold.release();
        return success((await Promise.all([first, second])).map((value) => value?.name));
      },
    });
    const { app } = await run(state.definitions, work);
    try {
      assert.deepEqual(await app.withScope((scope) => scope.resolve(work)()), success([undefined, "saved"]));
    } finally {
      hold.release();
      await app.stop();
    }
  },
);

test("a commit of another entity keeps the outside flight shared", { timeout: 10_000 }, async () => {
  const state = stackFixture(["top", "bottom"]);
  const hold = state.holdSource();
  const work = command({
    requirements: { saveLog },
    run: async (_, ctx) => success(await ctx.saveLog({ entity: "log", id: "l1", version: 1 })),
  });
  const { app, read } = await run(state.definitions, work);
  try {
    const first = read("r1");
    await hold.entered;
    assert.equal((await app.withScope((scope) => scope.resolve(work)())).isError, false);
    const seen = state.nextStoreRead();
    const second = read("r1");
    await seen;
    hold.release();
    assert.deepEqual(await Promise.all([first, second]), [role("r1", "old"), role("r1", "old")]);
    assert.equal(state.sourceCalls(), 1);
  } finally {
    hold.release();
    await app.stop();
  }
});

test("a commit keeps the flights of another entity's layers shared", { timeout: 10_000 }, async () => {
  const state = stackFixture(["top"]);
  const findLog = reader<(id: string) => Promise<Log | undefined>>();
  const hold = flightGate();
  let logReads = 0;
  let onStoreRead = () => {};
  const logLayer = cache({
    entity: "log",
    port: findLog,
    persist: () => () => undefined,
    bind: () => ({
      value: (_id: string) => {
        onStoreRead();
        return undefined;
      },
    }),
  });
  const logs = plug({
    port: findLog,
    bind: () => async (id: string) => {
      logReads++;
      hold.enter();
      await hold.wait;
      return { entity: "log" as const, id, version: 1 };
    },
  });
  const work = stackWork("delete");
  const { app } = await run([...state.definitions, logs, ...listed(logLayer)], work);
  const read = (id: string) => app.withScope((scope) => scope.resolve(findLog)(id));
  try {
    const first = read("l1");
    await hold.entered;
    assert.equal((await app.withScope((scope) => scope.resolve(work)())).isError, false);
    const seen = Promise.withResolvers<void>();
    onStoreRead = seen.resolve;
    const second = read("l1");
    await seen.promise;
    hold.release();
    await Promise.all([first, second]);
    assert.equal(logReads, 1);
  } finally {
    hold.release();
    await app.stop();
  }
});

test("a commit of two entities retires the flights of each", { timeout: 10_000 }, async () => {
  const state = stackFixture(["top"]);
  const hold = state.holdSource();
  const work = command({
    requirements: { removeRole, saveLog },
    run: async (_, ctx) => {
      await ctx.saveLog({ entity: "log", id: "l1", version: 1 });
      await ctx.removeRole(role("r1", "old"));
      return success();
    },
  });
  const { app, read } = await run(state.definitions, work);
  try {
    const first = read("r1");
    await hold.entered;
    assert.equal((await app.withScope((scope) => scope.resolve(work)())).isError, false);
    const seen = state.nextStoreRead();
    const after = read("r1");
    await seen;
    hold.release();
    const [, value] = await Promise.all([first, after]);
    assert.equal(value, undefined);
  } finally {
    hold.release();
    await app.stop();
  }
});

test("a commit in one application keeps another application's flights shared", { timeout: 10_000 }, async () => {
  const state = stackFixture(["top"]);
  const hold = state.holdSource();
  const work = stackWork("delete");
  const committing = await run(state.definitions, work);
  const reading = await run(state.definitions, work);
  try {
    const first = reading.read("r1");
    await hold.entered;
    assert.equal((await committing.app.withScope((scope) => scope.resolve(work)())).isError, false);
    const seen = state.nextStoreRead();
    const second = reading.read("r1");
    await seen;
    hold.release();
    assert.deepEqual(await Promise.all([first, second]), [role("r1", "old"), role("r1", "old")]);
    assert.equal(state.sourceCalls(), 1);
  } finally {
    hold.release();
    await committing.app.stop();
    await reading.app.stop();
  }
});

test("an unordered snapshot reloaded after an outage at the commit keeps the row", { timeout: 10_000 }, async () => {
  interface Note {
    readonly entity: "note";
    readonly id: string;
    readonly name: string;
  }
  const findNote = reader<(id: string) => Promise<Note | undefined>>();
  const listNotes = reader<() => Promise<readonly Note[]>>();
  const updateNote = writer<(value: Note) => Promise<Upserted<Note>>>();
  const ports = reader.compose({ byId: findNote, list: listNotes });
  const database = new Map<string, Note>([["n1", { entity: "note", id: "n1", name: "old" }]]);
  const memory = new Map<string, Note>();
  let storeReadFails = false;
  const layer = cache({
    entity: "note",
    strategy: "snapshot",
    startup: "blocking",
    port: ports,
    load: listNotes,
    persist: () => async (changes: readonly CacheChange[]) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Note);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else {
          memory.clear();
        }
      }
    },
    bind: () => ({
      byId: (id: string) => {
        if (storeReadFails) {
          storeReadFails = false;
          throw new Error("native store unavailable");
        }
        return memory.get(id);
      },
    }),
  });
  const reads = plug({
    port: ports,
    bind: () => ({
      byId: async (id: string) => database.get(id),
      list: async () => [...database.values()],
    }),
  });
  const updates = plug({
    port: updateNote,
    bind: () => async (value: Note) => {
      database.set(value.id, value);
      return upserted(value);
    },
  });
  const work = command<Note>()({
    requirements: { updateNote },
    run: async (value, ctx) => success(await ctx.updateNote(value)),
  });
  const { app } = await run([reads, ...listed(layer), updates], work);
  const read = (id: string) => app.withScope((scope) => scope.resolve(findNote)(id));
  const handle = app.resolve(layer.state as NonNullable<typeof layer.state>);
  try {
    storeReadFails = true;
    await read("n2");
    const outcome = await app.withScope((scope) => scope.resolve(work)({ entity: "note", id: "n1", name: "new" }));
    assert.equal(outcome.isError, false);
    await (handle as { readonly recovering: Promise<void> | undefined }).recovering;
    assert.equal((await read("n1"))?.name, "new");
    assert.equal(memory.get("n1")?.name, "new");
  } finally {
    await app.stop();
  }
});

function snapshotStack(names: readonly string[], lostLayer?: string) {
  const listRoles = reader<() => Promise<readonly Role[]>>();
  const port = reader.compose({ byId: findRole, list: listRoles });
  const database = new Map([["r1", role("r1", "old")]]);
  const stores = new Map<string, Map<string, Role>>();
  const connection = makeConnection();
  const writeHolds = new Map<string, ReturnType<typeof flightGate>>();
  const clearHolds = new Map<string, ReturnType<typeof flightGate>>();
  const failingStoreReads = new Set<string>();
  const layers = names.map((name) => {
    const memory = new Map<string, Role>();
    stores.set(name, memory);
    return cache({
      name,
      entity: "role",
      strategy: "snapshot",
      startup: "blocking",
      load: listRoles,
      port,
      ...(name === lostLayer ? { connection: () => connection.conn } : {}),
      persist: () => async (changes: readonly CacheChange[]) => {
        const isClear = changes.some((change) => change.type === "clear");
        const holds = isClear ? clearHolds : writeHolds;
        const hold = holds.get(name);
        holds.delete(name);
        if (hold !== undefined) {
          hold.enter();
          await hold.wait;
        }
        for (const change of changes) {
          if (change.type === "set") {
            memory.set(String(change.key), change.value as Role);
          } else if (change.type === "delete") {
            memory.delete(String(change.key));
          } else {
            memory.clear();
          }
        }
      },
      bind: () => ({
        byId: (id: string) => {
          if (failingStoreReads.delete(name)) {
            throw new Error("native store unavailable");
          }
          return memory.get(id);
        },
        list: () => [...memory.values()],
      }),
    });
  });
  const reads = plug({
    port,
    bind: () => ({
      byId: async (id: string) => database.get(id),
      list: async () => [...database.values()],
    }),
  });
  const saves = plug({
    port: saveRole,
    bind: () => async (value: Role) => {
      const stored = { ...value, version: value.version + 1 };
      database.set(value.id, stored);
      return upserted(stored);
    },
  });
  const removes = plug({
    port: removeRole,
    bind: () => async (value: Role) => {
      database.delete(value.id);
      return deleted(value);
    },
  });
  return {
    database,
    stores,
    connection,
    listRoles,
    layers,
    definitions: [reads, ...listed(...layers), saves, removes],
    holdWrite(name: string) {
      const hold = flightGate();
      writeHolds.set(name, hold);
      return hold;
    },
    holdClear(name: string) {
      const hold = flightGate();
      clearHolds.set(name, hold);
      return hold;
    },
    failNextStoreRead(name: string) {
      failingStoreReads.add(name);
    },
  };
}

const snapshotWrites = {
  update: { row: "r1", write: role("r1", "new"), expected: "new", listed: ["new"] },
  insert: { row: "r9", write: role("r9", "added", 0), expected: "added", listed: ["added", "old"] },
  delete: { row: "r1", write: role("r1", "old"), expected: undefined, listed: [] },
} as const;

for (const { names, down, held, write, outage, lateClear } of [
  { names: ["top", "bottom"], down: "top", held: "bottom", write: "update", outage: "failed", lateClear: false },
  { names: ["top", "bottom"], down: "top", held: "bottom", write: "insert", outage: "failed", lateClear: false },
  { names: ["top", "bottom"], down: "top", held: "bottom", write: "delete", outage: "failed", lateClear: false },
  { names: ["top", "bottom"], down: "top", held: "bottom", write: "update", outage: "lost", lateClear: false },
  { names: ["top", "bottom"], down: "top", held: "bottom", write: "update", outage: "failed", lateClear: true },
  {
    names: ["top", "middle", "bottom"],
    down: "top",
    held: "middle",
    write: "update",
    outage: "failed",
    lateClear: false,
  },
  {
    names: ["top", "middle", "bottom"],
    down: "top",
    held: "middle",
    write: "delete",
    outage: "failed",
    lateClear: false,
  },
  {
    names: ["top", "middle", "bottom"],
    down: "middle",
    held: "bottom",
    write: "update",
    outage: "lost",
    lateClear: false,
  },
] as const) {
  const label = [
    names.join("/"),
    down + " down through a " + outage + " store",
    held + " persist held",
    write,
    lateClear ? "a clear that lands late" : "",
  ]
    .filter((part) => part !== "")
    .join(", ");
  test(
    "a complete snapshot reloaded during a lower store's write keeps the commit: " + label,
    {
      timeout: 10_000,
    },
    async () => {
      const state = snapshotStack(names, outage === "lost" ? down : undefined);
      const { row, write: value, expected, listed } = snapshotWrites[write];
      let effectRead: string | undefined = "not run";
      const work = command({
        requirements: { findRole, saveRole, removeRole },
        run: async (_, ctx) => {
          ctx.uow.afterCommit(async () => {
            effectRead = (await ctx.findRole(row))?.name;
          });
          if (write === "delete") {
            await ctx.removeRole(value);
          } else {
            await ctx.saveRole(value);
          }
          return success();
        },
      });
      const { app, read } = await run(state.definitions, work);
      const list = () => app.withScope((scope) => scope.resolve(state.listRoles)());
      const layer = state.layers[names.findIndex((name) => name === down)];
      assert.ok(layer !== undefined);
      const handle = app.resolve(layer.state as NonNullable<typeof layer.state>) as {
        readonly recovering: Promise<void> | undefined;
        readonly unavailable: boolean;
      };
      const lowerWrite = state.holdWrite(held);
      const clear = lateClear ? state.holdClear(down) : undefined;
      try {
        assert.equal((await read("r1"))?.name, "old");
        if (outage === "lost") {
          state.connection.lose();
        } else {
          state.failNextStoreRead(down);
          await read("r2");
        }
        const pending = app.withScope((scope) => scope.resolve(work)());
        await lowerWrite.entered;
        if (outage === "lost") {
          state.connection.restore();
        }
        if (clear !== undefined) {
          await clear.entered;
          clear.release();
        }
        await handle.recovering;
        lowerWrite.release();
        assert.equal((await pending).isError, false);
        assert.equal(state.database.get(row)?.name, expected);
        assert.equal(effectRead, expected);
        assert.equal((await read(row))?.name, expected);
        assert.deepEqual((await list()).map((entry) => entry.name).sort(), listed);
        assert.equal(state.stores.get(down)?.get(row)?.name, expected);
        assert.equal(handle.unavailable, false);
      } finally {
        clear?.release();
        lowerWrite.release();
        await app.stop();
      }
    },
  );
}

import { failure } from "@openknot-ts/behavior";
import { AsyncLocalStorage } from "node:async_hooks";

/** A Unit of Work that keeps its session in its own async context, as a native transaction plug does. */
function sessionDatabase(rows: readonly Role[]) {
  const sessions = new AsyncLocalStorage<Map<string, Role>>();
  let committed = new Map(rows.map((row) => [row.id, row]));
  return {
    get current() {
      return sessions.getStore() ?? committed;
    },
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      const session = new Map(committed);
      const result = await sessions.run(session, work);
      committed = session;
      return result;
    },
  };
}

for (const inside of [true, false]) {
  test(
    `a snapshot recovery started by a read ${inside ? "inside" : "outside"} a Unit of Work stores no uncommitted row`,
    {
      timeout: 10_000,
    },
    async () => {
      const listRoles = reader<() => Promise<readonly Role[]>>();
      const port = reader.compose({ byId: findRole, list: listRoles });
      const database = sessionDatabase([role("r1", "admin")]);
      const ambient = new AsyncLocalStorage<string>();
      const loadedIn: (string | undefined)[] = [];
      const memory = new Map<string, Role>();
      let storeReadFails = false;
      const layer = cache({
        entity: "role",
        strategy: "snapshot",
        startup: "blocking",
        port,
        load: listRoles,
        persist: () => (changes: readonly CacheChange[]) => {
          for (const change of changes) {
            if (change.type === "set") {
              memory.set(String(change.key), change.value as Role);
            } else if (change.type === "delete") {
              memory.delete(String(change.key));
            } else {
              memory.clear();
            }
          }
        },
        bind: () => ({
          byId: (id: string) => {
            if (storeReadFails) {
              storeReadFails = false;
              throw new Error("native store unavailable");
            }
            return memory.get(id);
          },
          list: () => [...memory.values()],
        }),
      });
      const reads = plug({
        port,
        bind: () => ({
          byId: async (id: string) => database.current.get(id),
          list: async () => {
            loadedIn.push(ambient.getStore());
            return [...database.current.values()];
          },
        }),
      });
      const saves = plug({
        port: saveRole,
        bind: () => async (value: Role) => {
          const stored = { ...value, version: value.version + 1 };
          database.current.set(value.id, stored);
          return upserted(stored);
        },
      });
      const recovered = () =>
        (
          app.resolve(layer.state as NonNullable<typeof layer.state>) as {
            readonly recovering: Promise<void> | undefined;
          }
        ).recovering;
      const vetoed = command({
        requirements: { saveRole, findRole },
        run: async (_, ctx) => {
          await ctx.saveRole(role("phantom", "ghost", 0));
          if (inside) {
            await ctx.findRole("r1");
            await recovered();
          }
          return failure(new Error("veto"));
        },
      });
      const { app, read } = await ambient.run("startup", () =>
        run([reads, ...listed(layer), saves, plug({ port: defaultUnitOfWork, bind: () => database })], vetoed),
      );
      try {
        storeReadFails = true;
        await read("r2");
        const outcome = await ambient.run("request", () => app.withScope((scope) => scope.resolve(vetoed)()));
        assert.equal(outcome.isError, true);
        assert.equal(database.current.has("phantom"), false);
        if (!inside) {
          await ambient.run("request", () => read("r1"));
          await recovered();
        }
        assert.deepEqual([...memory.keys()], ["r1"]);
        assert.deepEqual(loadedIn, ["startup", "startup"]);
      } finally {
        await app.stop();
      }
    },
  );
}

for (const strategy of ["read-through", "write-through"] as const) {
  test(
    `a ${strategy} layer over a store of single entities sends a list to the next layer`,
    {
      timeout: 10_000,
    },
    async () => {
      const listRoles = reader<() => Promise<readonly Role[]>>();
      const port = reader.compose({ byId: findRole, list: listRoles });
      const database = new Map([
        ["r1", role("r1", "admin")],
        ["r2", role("r2", "editor")],
      ]);
      const memory = new Map<string, Role>();
      const layer = cache({
        entity: "role",
        strategy,
        port,
        writers: saveRole,
        persist: () => (changes: readonly CacheChange[]) => {
          for (const change of changes) {
            if (change.type === "set") {
              memory.set(String(change.key), change.value as Role);
            } else if (change.type === "delete") {
              memory.delete(String(change.key));
            } else {
              memory.clear();
            }
          }
        },
        bind: () => ({ byId: (id: string) => memory.get(id), list: () => [...memory.values()] }),
      });
      const reads = plug({
        port,
        bind: () => ({
          byId: async (id: string) => database.get(id),
          list: async () => [...database.values()],
        }),
      });
      const saves = plug({
        port: saveRole,
        bind: () => async (value: Role) => {
          const stored = { ...value, version: value.version + 1 };
          database.set(value.id, stored);
          return upserted(stored);
        },
      });
      const save = command<Role>()({
        requirements: { saveRole },
        run: async (value, ctx) => success(await ctx.saveRole(value)),
      });
      const { app, read, call } = await run([reads, ...listed(layer), saves], save);
      try {
        if (strategy === "read-through") {
          await read("r1");
        } else {
          await call(role("r1", "admin"));
        }
        assert.equal(memory.size, 1);
        const listed = await app.withScope((scope) => scope.resolve(listRoles)());
        assert.deepEqual(listed.map((value) => value.id).sort(), ["r1", "r2"]);
        assert.equal(memory.size, 1);
      } finally {
        await app.stop();
      }
    },
  );
}

test(
  "a list passes a read-through layer and is answered by a complete snapshot below it",
  {
    timeout: 10_000,
  },
  async () => {
    const listRoles = reader<() => Promise<readonly Role[]>>();
    const port = reader.compose({ byId: findRole, list: listRoles });
    const top = new Map<string, Role>([["r1", role("r1", "admin")]]);
    const bottom = new Map<string, Role>();
    let sourceLists = 0;
    const persistTo = (memory: Map<string, Role>) => () => (changes: readonly CacheChange[]) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else {
          memory.clear();
        }
      }
    };
    const bindTo = (memory: Map<string, Role>) => () => ({
      byId: (id: string) => memory.get(id),
      list: () => [...memory.values()],
    });
    const reads = plug({
      port,
      bind: () => ({
        byId: async () => undefined,
        list: async () => {
          sourceLists++;
          return [role("r1", "admin"), role("r2", "editor")];
        },
      }),
    });
    const noop = command({ requirements: {}, run: async () => success(undefined) });
    const { app } = await run(
      [
        reads,
        ...listed(
          cache({ name: "top", entity: "role", port, persist: persistTo(top), bind: bindTo(top) }),
          cache({
            name: "bottom",
            entity: "role",
            strategy: "snapshot",
            startup: "blocking",
            load: listRoles,
            port,
            persist: persistTo(bottom),
            bind: bindTo(bottom),
          }),
        ),
      ],
      noop,
    );
    try {
      assert.equal(sourceLists, 1);
      const listed = await app.withScope((scope) => scope.resolve(listRoles)());
      assert.deepEqual(listed.map((value) => value.id).sort(), ["r1", "r2"]);
      assert.equal(sourceLists, 1);
    } finally {
      await app.stop();
    }
  },
);

test("a result cache keyed by arguments answers its cached list", { timeout: 10_000 }, async () => {
  const search = reader<(term: string) => Promise<readonly string[]>>();
  const memory = new Map<unknown, readonly string[]>();
  let sourceReads = 0;
  const layer = cache({
    port: search,
    persist: () => (changes: readonly CacheChange[]) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(change.key, change.value as readonly string[]);
        }
      }
    },
    bind: () => ({ value: (term: string) => memory.get(cacheKey(term)) }),
  });
  const reads = plug({
    port: search,
    bind: () => async (term: string) => {
      sourceReads++;
      return [term, "other"];
    },
  });
  const noop = command({ requirements: {}, run: async () => success(undefined) });
  const { app } = await run([reads, ...listed(layer)], noop);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(search)("a")), ["a", "other"]);
    assert.deepEqual(await app.withScope((scope) => scope.resolve(search)("a")), ["a", "other"]);
    assert.equal(sourceReads, 1);
  } finally {
    await app.stop();
  }
});

function lostStoreFixture(strategy: "read-through" | "snapshot" = "read-through") {
  const listRoles = reader<() => Promise<readonly Role[]>>();
  const port = reader.compose({ byId: findRole, list: listRoles });
  const database = new Map([["r1", role("r1", "admin")]]);
  const memory = new Map<string, Role>();
  const connection = makeConnection();
  const persistHolds: ReturnType<typeof flightGate>[] = [];
  let readHold: ReturnType<typeof flightGate> | undefined;
  let clears = 0;
  let lastPersist: Promise<void> | undefined;
  let nextPersistFails = false;
  let lostOnPersist = false;
  const layer = cache({
    entity: "role",
    port,
    writers: saveRole,
    connection: () => connection.conn,
    ...(strategy === "snapshot" ? { strategy, startup: "blocking" as const, load: listRoles } : { strategy }),
    persist: () => (changes: readonly CacheChange[]) => {
      if (changes.some((change) => change.type === "clear")) {
        clears++;
      }
      const hold = persistHolds.shift();
      if (hold !== undefined && lostOnPersist) {
        connection.lose();
      }
      const fails = hold !== undefined && nextPersistFails;
      if (fails) {
        nextPersistFails = false;
      }
      const persisting = (async () => {
        if (hold !== undefined) {
          hold.enter();
          await hold.wait;
        }
        if (fails) {
          throw new Error("native store unavailable");
        }
        for (const change of changes) {
          if (change.type === "set") {
            memory.set(String(change.key), change.value as Role);
          } else if (change.type === "delete") {
            memory.delete(String(change.key));
          } else {
            memory.clear();
          }
        }
      })();
      lastPersist = persisting.catch(() => undefined);
      return persisting;
    },
    bind: () => ({
      byId: (id: string) => {
        const hold = readHold;
        readHold = undefined;
        if (hold === undefined) {
          return memory.get(id);
        }
        hold.enter();
        return hold.wait.then(() => memory.get(id));
      },
      list: () => [...memory.values()],
    }),
  });
  const reads = plug({
    port,
    bind: () => ({
      byId: async (id: string) => database.get(id),
      list: async () => [...database.values()],
    }),
  });
  const saves = plug({
    port: saveRole,
    bind: () => async (value: Role) => {
      const stored = { ...value, version: value.version + 1 };
      database.set(value.id, stored);
      return upserted(stored);
    },
  });
  const save = command<Role>()({
    requirements: { saveRole },
    run: async (value, ctx) => success(await ctx.saveRole(value)),
  });
  return {
    database,
    memory,
    connection,
    layer,
    listRoles,
    save,
    definitions: [reads, ...listed(layer), saves, layer.health, healthProbes],
    holdPersist(options: { readonly failing?: boolean; readonly lost?: boolean } = {}) {
      const hold = flightGate();
      persistHolds.push(hold);
      nextPersistFails = options.failing === true;
      lostOnPersist = options.lost === true;
      return hold;
    },
    holdRead() {
      readHold = flightGate();
      return readHold;
    },
    get clears() {
      return clears;
    },
    get lastPersist() {
      return lastPersist;
    },
  };
}
type LostStoreFixture = ReturnType<typeof lostStoreFixture>;

function lostStoreHandles(app: Awaited<ReturnType<typeof run>>["app"], state: LostStoreFixture) {
  const handle = app.resolve(state.layer.state as NonNullable<typeof state.layer.state>) as {
    readonly recovering: Promise<void> | undefined;
    readonly unavailable: boolean;
  };
  const health = () =>
    app.withScope(async (scope) =>
      (await scope.resolve(state.layer.health)).check({ signal: new AbortController().signal }),
    );
  return { handle, health };
}

test(
  "a command whose persist is held when the store is lost settles, and reads answer from the source",
  {
    timeout: 10_000,
  },
  async () => {
    const state = lostStoreFixture();
    const { app, call, read } = await run(state.definitions, state.save);
    const persist = state.holdPersist();
    try {
      const pending = call(role("r1", "renamed", 1));
      await persist.entered;
      state.connection.lose();
      assert.equal((await (pending as Promise<{ readonly isError: boolean }>)).isError, false);
      assert.equal((await read("r1"))?.name, "renamed");
      assert.equal(state.memory.has("r1"), false);
    } finally {
      persist.release();
      await app.stop();
    }
  },
);

test("a command settles when its store is lost while it issues the persist", { timeout: 10_000 }, async () => {
  const state = lostStoreFixture();
  const { app, call } = await run(state.definitions, state.save);
  const persist = state.holdPersist({ lost: true });
  try {
    const outcome = await (call(role("r1", "renamed", 1)) as Promise<{ readonly isError: boolean }>);
    assert.equal(outcome.isError, false);
  } finally {
    persist.release();
    await app.stop();
  }
});

for (const { strategy, restoredAtOnce } of [
  { strategy: "read-through", restoredAtOnce: false },
  { strategy: "read-through", restoredAtOnce: true },
  { strategy: "snapshot", restoredAtOnce: false },
  { strategy: "snapshot", restoredAtOnce: true },
] as const) {
  test(
    `a native read held when the store is lost answers from the source: ${strategy}${restoredAtOnce ? ", restored at once" : ""}`,
    {
      timeout: 10_000,
    },
    async () => {
      const state = lostStoreFixture(strategy);
      const { app, read } = await run(state.definitions, state.save);
      const nativeRead = state.holdRead();
      try {
        // The held read would answer a stale row from a read-through store and absence from a complete snapshot.
        if (strategy === "read-through") {
          state.memory.set("r1", role("r1", "stale"));
        } else {
          state.memory.delete("r1");
        }
        const pending = read("r1");
        await nativeRead.entered;
        state.connection.lose();
        if (restoredAtOnce) {
          state.connection.restore();
        }
        assert.equal((await pending)?.name, "admin");
      } finally {
        nativeRead.release();
        await app.stop();
      }
    },
  );
}

test("stop finishes behind a lost store that holds a command", { timeout: 10_000 }, async () => {
  const state = lostStoreFixture();
  const { app, call } = await run(state.definitions, state.save);
  const persist = state.holdPersist();
  try {
    const pending = call(role("r1", "renamed", 1));
    await persist.entered;
    state.connection.lose();
    await app.stop();
    assert.equal((await (pending as Promise<{ readonly isError: boolean }>)).isError, false);
  } finally {
    persist.release();
  }
});

test("a blocking snapshot starts when the store is lost during its load", { timeout: 10_000 }, async () => {
  const state = lostStoreFixture("snapshot");
  const clear = state.holdPersist();
  const starting = run(state.definitions, state.save);
  await clear.entered;
  state.connection.lose();
  const { app, read } = await starting;
  try {
    assert.equal((await read("r1"))?.name, "admin");
    assert.equal(state.memory.size, 0);
  } finally {
    clear.release();
    await app.stop();
  }
});

test(
  "a store restored during a recovery schedules another recovery that ends with the layer up",
  {
    timeout: 10_000,
  },
  async () => {
    const state = lostStoreFixture();
    const { app } = await run(state.definitions, state.save);
    const { handle, health } = lostStoreHandles(app, state);
    const firstClear = state.holdPersist();
    const secondClear = state.holdPersist();
    try {
      state.connection.lose();
      state.connection.restore();
      await firstClear.entered;
      assert.equal(await health(), "down");
      state.connection.lose();
      state.connection.restore();
      await secondClear.entered;
      assert.equal(state.clears, 2);
      assert.equal(await health(), "down");
      secondClear.release();
      await handle.recovering;
      assert.equal(handle.unavailable, false);
      assert.equal(await health(), "up");
    } finally {
      firstClear.release();
      secondClear.release();
      await app.stop();
    }
  },
);

test("a store lost again during a recovery waits for its next restoration", { timeout: 10_000 }, async () => {
  const state = lostStoreFixture();
  const { app } = await run(state.definitions, state.save);
  const { handle, health } = lostStoreHandles(app, state);
  const clear = state.holdPersist();
  try {
    state.connection.lose();
    state.connection.restore();
    await clear.entered;
    state.connection.lose();
    await handle.recovering;
    assert.equal(state.clears, 1);
    assert.equal(await health(), "down");
    state.connection.restore();
    await handle.recovering;
    assert.equal(state.clears, 2);
    assert.equal(await health(), "up");
  } finally {
    clear.release();
    await app.stop();
  }
});

test("a released persist that fails later does not bring the recovered layer down", { timeout: 10_000 }, async () => {
  const state = lostStoreFixture();
  const { app, call } = await run(state.definitions, state.save);
  const { handle, health } = lostStoreHandles(app, state);
  const persist = state.holdPersist({ failing: true });
  try {
    const pending = call(role("r1", "renamed", 1));
    await persist.entered;
    const failing = state.lastPersist;
    state.connection.lose();
    await pending;
    state.connection.restore();
    await handle.recovering;
    persist.release();
    await failing;
    assert.equal(await health(), "up");
    assert.equal(state.clears, 1);
  } finally {
    persist.release();
    await app.stop();
  }
});

test("a commit released at a lost store ends its bookkeeping", { timeout: 10_000 }, async () => {
  interface Note {
    readonly entity: "note";
    readonly id: string;
    readonly name: string;
  }
  const findNote = reader<(id: string) => Promise<Note | undefined>>();
  const updateNote = writer<(value: Note) => Promise<Upserted<Note>>>();
  const database = new Map<string, Note>();
  const memory = new Map<string, Note>();
  const connection = makeConnection();
  const persist = flightGate();
  let holding = true;
  const layer = cache({
    entity: "note",
    port: findNote,
    connection: () => connection.conn,
    persist: () => async (changes: readonly CacheChange[]) => {
      if (holding) {
        holding = false;
        persist.enter();
        await persist.wait;
      }
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Note);
        } else if (change.type === "delete") {
          memory.delete(String(change.key));
        } else {
          memory.clear();
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({ port: findNote, bind: () => async (id: string) => database.get(id) });
  const updates = plug({
    port: updateNote,
    bind: () => async (value: Note) => {
      database.set(value.id, value);
      return upserted(value);
    },
  });
  const work = command<Note>()({
    requirements: { updateNote },
    run: async (value, ctx) => success(await ctx.updateNote(value)),
  });
  const { app } = await run([reads, ...listed(layer), updates], work);
  const handle = app.resolve(layer.state as NonNullable<typeof layer.state>) as {
    readonly recovering: Promise<void> | undefined;
  };
  try {
    const pending = app.withScope((scope) => scope.resolve(work)({ entity: "note", id: "n1", name: "new" }));
    await persist.entered;
    connection.lose();
    assert.equal((await pending).isError, false);
    connection.restore();
    await handle.recovering;
    persist.release();
    // A live mark would drop this fill of a state without an order.
    assert.equal((await app.withScope((scope) => scope.resolve(findNote)("n1")))?.name, "new");
    assert.equal(memory.get("n1")?.name, "new");
  } finally {
    persist.release();
    await app.stop();
  }
});

for (const topState of ["up", "down"] as const) {
  test(
    `an include that throws on an upper layer ${topState} at the commit leaves no lower old entry in it`,
    {
      timeout: 10_000,
    },
    async () => {
      const database = new Map([["r1", role("r1", "old")]]);
      const top = new Map<string, Role>();
      const bottom = new Map<string, Role>([["r1", role("r1", "old")]]);
      const lowerWrite = flightGate();
      let includeThrows = false;
      let storeReadFails = false;
      const applyTo = (memory: Map<string, Role>, changes: readonly CacheChange[]) => {
        for (const change of changes) {
          if (change.type === "set") {
            memory.set(String(change.key), change.value as Role);
          } else if (change.type === "delete") {
            memory.delete(String(change.key));
          } else {
            memory.clear();
          }
        }
      };
      let holdLower = false;
      const upper = cache({
        name: "top",
        entity: "role",
        port: findRole,
        include: () => () => {
          if (includeThrows) {
            includeThrows = false;
            throw new Error("include failed");
          }
          return true;
        },
        persist: () => async (changes: readonly CacheChange[]) => applyTo(top, changes),
        bind: () => ({
          value: (id: string) => {
            if (storeReadFails) {
              storeReadFails = false;
              throw new Error("native store unavailable");
            }
            return top.get(id);
          },
        }),
      });
      const lower = cache({
        name: "bottom",
        entity: "role",
        port: findRole,
        persist: () => async (changes: readonly CacheChange[]) => {
          if (holdLower) {
            holdLower = false;
            lowerWrite.enter();
            await lowerWrite.wait;
          }
          applyTo(bottom, changes);
        },
        bind: () => ({ value: (id: string) => bottom.get(id) }),
      });
      const reads = plug({ port: findRole, bind: () => async (id: string) => database.get(id) });
      const saves = plug({
        port: saveRole,
        bind: () => async (value: Role) => {
          const stored = { ...value, version: value.version + 1 };
          database.set(value.id, stored);
          return upserted(stored);
        },
      });
      const save = command<Role>()({
        requirements: { saveRole },
        run: async (value, ctx) => success(await ctx.saveRole(value)),
      });
      const { app, read, call } = await run([reads, ...listed(upper, lower), saves], save);
      const handle = app.resolve(upper.state as NonNullable<typeof upper.state>) as {
        readonly recovering: Promise<void> | undefined;
      };
      try {
        if (topState === "down") {
          storeReadFails = true;
          await read("r2");
        }
        includeThrows = true;
        holdLower = true;
        const pending = call(role("r1", "new")) as Promise<{ readonly isError: boolean; readonly error?: unknown }>;
        await lowerWrite.entered;
        // A layer down at the commit starts its recovery on this read, and the next read can fill it.
        assert.equal((await read("r1"))?.name, "old");
        await handle.recovering;
        assert.equal((await read("r1"))?.name, "old");
        lowerWrite.release();
        const outcome = await pending;
        assert.equal(outcome.isError, true);
        assert.equal(database.get("r1")?.name, "new");
        assert.equal((await read("r1"))?.name, "new");
        assert.equal(top.get("r1")?.name, "new");
      } finally {
        lowerWrite.release();
        await app.stop();
      }
    },
  );
}

for (const held of ["clear", "marks"] as const) {
  test(`a snapshot reload holds back reads until its ${held} reached the store`, { timeout: 10_000 }, async () => {
    const state = snapshotStack(["top", "bottom"]);
    const { row, write: value, expected, listed } = snapshotWrites.update;
    const work = command({
      requirements: { saveRole },
      run: async (_, ctx) => success(await ctx.saveRole(value)),
    });
    const { app, read } = await run(state.definitions, work);
    const list = () => app.withScope((scope) => scope.resolve(state.listRoles)());
    const [layer] = state.layers;
    assert.ok(layer !== undefined);
    const handle = app.resolve(layer.state as NonNullable<typeof layer.state>) as {
      readonly recovering: Promise<void> | undefined;
    };
    const lowerWrite = state.holdWrite("bottom");
    const hold = held === "clear" ? state.holdClear("top") : state.holdWrite("top");
    try {
      state.failNextStoreRead("top");
      await read("r2");
      const pending = app.withScope((scope) => scope.resolve(work)());
      await lowerWrite.entered;
      await hold.entered;
      // Two complete reads: a reload that went on without this write would have ended by the second.
      assert.equal((await read(row))?.name, "old");
      assert.equal((await read(row))?.name, "old");
      assert.equal(state.stores.get("top")?.get(row)?.name, held === "clear" ? "old" : undefined);
      hold.release();
      await handle.recovering;
      lowerWrite.release();
      assert.equal((await pending).isError, false);
      assert.equal((await read(row))?.name, expected);
      assert.deepEqual((await list()).map((entry) => entry.name).sort(), listed);
      assert.equal(state.stores.get("top")?.get(row)?.name, expected);
    } finally {
      hold.release();
      lowerWrite.release();
      await app.stop();
    }
  });
}

test("a mark from a commit while the layer was up restores the row in the reload", { timeout: 10_000 }, async () => {
  const state = snapshotStack(["top", "bottom"]);
  const { row, write: value, expected, listed } = snapshotWrites.update;
  const work = command({
    requirements: { saveRole },
    run: async (_, ctx) => success(await ctx.saveRole(value)),
  });
  const { app, read } = await run(state.definitions, work);
  const list = () => app.withScope((scope) => scope.resolve(state.listRoles)());
  const [layer] = state.layers;
  assert.ok(layer !== undefined);
  const handle = app.resolve(layer.state as NonNullable<typeof layer.state>) as {
    readonly recovering: Promise<void> | undefined;
  };
  const lowerWrite = state.holdWrite("bottom");
  try {
    const pending = app.withScope((scope) => scope.resolve(work)());
    await lowerWrite.entered;
    assert.equal(state.stores.get("top")?.get(row)?.name, expected);
    state.failNextStoreRead("top");
    await read("r2");
    assert.equal((await read(row))?.name, "old");
    await handle.recovering;
    assert.equal(state.stores.get("top")?.get(row)?.name, expected);
    lowerWrite.release();
    assert.equal((await pending).isError, false);
    assert.equal((await read(row))?.name, expected);
    assert.deepEqual((await list()).map((entry) => entry.name).sort(), listed);
  } finally {
    lowerWrite.release();
    await app.stop();
  }
});

for (const failureAt of ["read", "clear", "load"] as const) {
  test(`cache ${failureAt} failure reports in its owning context`, { timeout: 10_000 }, async (t) => {
    const ambient = new AsyncLocalStorage<string>();
    const parents: (string | undefined)[] = [];
    const failed = Promise.withResolvers<void>();
    const tracing: Tracing = {
      async run(span, work) {
        if (span.name === "role-cache unavailable") {
          parents.push(ambient.getStore());
          failed.resolve();
        }
        return work();
      },
      capture: () => undefined,
      bind: (work) => work,
    };
    let failing = false;
    const connection = makeConnection();
    const layer = cache({
      entity: "role",
      port: findRole,
      strategy: "snapshot",
      startup: "blocking",
      connection: () => connection.conn,
      load: async () => {
        if (failing && failureAt === "load") {
          throw new Error("load failed");
        }
        return [role("r1", "admin")];
      },
      persist: () => async (changes) => {
        if (failing && failureAt === "clear" && changes.some((change) => change.type === "clear")) {
          throw new Error("clear failed");
        }
      },
      bind: () => ({
        value: () => {
          if (failing && failureAt === "read") {
            throw new Error("read failed");
          }
          return undefined;
        },
      }),
    });
    const reads = plug({ port: findRole, bind: () => async () => role("r1", "admin") });
    const noop = command({ requirements: {}, run: async () => success() });
    const { app, read } = await ambient.run("startup", () =>
      run([reads, ...listed(layer), unit({ provides: trace, factory: () => tracing })], noop),
    );
    try {
      failing = true;
      await ambient.run("request", async () => {
        if (failureAt === "read") {
          assert.equal((await read("r1"))?.name, "admin");
        } else {
          connection.lose();
          connection.restore();
        }
        await failed.promise;
      });
      t.diagnostic(JSON.stringify({ failureAt, parents }));
      assert.deepEqual(parents, [failureAt === "read" ? "request" : "startup"]);
    } finally {
      await app.stop();
    }
  });
}

test("a cache retains the context captured at application startup", { timeout: 10_000 }, async () => {
  const ambient = new AsyncLocalStorage<string>();
  const connection = makeConnection();
  const memory = new Map<string, Role>();
  const layer = cache({
    entity: "role",
    port: findRole,
    strategy: "snapshot",
    startup: "blocking",
    connection: () => connection.conn,
    load: () => [role("r1", ambient.getStore() ?? "absent")],
    persist: () => (changes) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        } else if (change.type === "clear") {
          memory.clear();
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const reads = plug({ port: findRole, bind: () => async () => undefined });
  const noop = command({ requirements: {}, run: async () => success() });
  const { app, read } = await ambient.run("startup", () => run([reads, ...listed(layer)], noop));
  const handle = app.resolve(layer.state as NonNullable<typeof layer.state>) as {
    readonly recovering: Promise<void> | undefined;
  };
  try {
    await ambient.run("request", async () => {
      connection.lose();
      connection.restore();
      await handle.recovering;
    });
    assert.equal((await read("r1"))?.name, "startup");
  } finally {
    await app.stop();
  }
});
