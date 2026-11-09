import type { ReplicaMarker, ReplicationMessage } from "../src/index.ts";
import { replicaStore, replication, replicationChannel } from "../src/index.ts";
import { memoryBus, memoryLock, memoryStore } from "./fakes.ts";
import { deleted, reader, success } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/behavior/wire";
import type { CacheChange } from "@openknot-ts/cache";
import type { Deleted, Upserted } from "@openknot-ts/flow";
import { command, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { healthProbes } from "@openknot-ts/health";
import type { Lock } from "@openknot-ts/lock";
import { lock } from "@openknot-ts/lock/wire";
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
  readonly version: number;
}
const role = (id: string, name: string, version = 1): Role => ({ entity: "role", id, name, version });

const findRole = reader<(id: string) => Promise<Role | undefined>>();
const listRoles = reader<() => Promise<readonly Role[]>>();
const saveRole = writer<(value: Role) => Promise<Upserted<Role>>>();

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function world(
  options: {
    readonly database?: Map<string, Role>;
    readonly revision?: number;
    readonly startup?: "background" | "blocking";
    /** Gives both replication sections a `list` member besides `byId`. */
    readonly members?: { readonly list?: boolean };
    /** The distributed layer's include. */
    readonly include?: (state: unknown) => boolean;
    /** The instance layer's include. */
    readonly localInclude?: (state: unknown) => boolean;
    /** Makes the instance store's read asynchronous; it receives the value that read took. */
    readonly localRead?: (value: Role | undefined) => Promise<Role | undefined>;
  } = {},
) {
  const withList = options.members?.list === true;
  const localInclude = options.localInclude;
  const database = options.database ?? new Map<string, Role>();
  const reads = { byId: 0, list: 0 };
  const load: { started?: () => void; held?: Promise<void>; failures: number; gates: Promise<void>[]; pages?: number } =
    {
      failures: 0,
      gates: [],
    };
  const watchers = new Set<(local: Map<string, Role>, changes: readonly CacheChange[]) => void>();
  const roleReaders = plug({
    port: reader.compose({ byId: findRole, list: listRoles }),
    bind: () => ({
      byId: async (id: string) => {
        reads.byId++;
        return database.get(id);
      },
      list: async () => {
        reads.list++;
        const values = [...database.values()];
        const gatePromise = load.gates.shift();
        load.started?.();
        if (gatePromise !== undefined) {
          await gatePromise;
        }
        await load.held;
        if (load.failures > 0) {
          load.failures--;
          throw new Error("source unavailable");
        }
        if (load.pages === undefined) {
          return values;
        }
        // A paged source answers the load with an async iterable of pages.
        const size = Math.ceil(values.length / load.pages);
        return (async function* () {
          for (let start = 0; start < values.length; start += size) {
            yield values.slice(start, start + size);
          }
        })() as unknown as readonly Role[];
      },
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
  const localRoles = unit({ factory: () => new Map<string, Role>() });
  const rolesLocal = replication.instance({
    requirements: { localRoles },
    port: withList ? reader.compose({ byId: findRole, list: listRoles }) : reader.compose({ byId: findRole }),
    persist:
      ({ localRoles: local }) =>
      (changes) => {
        for (const change of changes) {
          if (change.type === "set") {
            local.set(String(change.key), change.value as Role);
          } else if (change.type === "delete") {
            local.delete(String(change.key));
          } else {
            local.clear();
          }
        }
        for (const watch of watchers) {
          watch(local, changes);
        }
      },
    bind: ({ localRoles: local }) => ({
      byId: (id: string) => (options.localRead === undefined ? local.get(id) : options.localRead(local.get(id))),
      ...(withList ? { list: () => [...local.values()] } : {}),
    }),
    ...(localInclude === undefined ? {} : { include: () => localInclude }),
  });
  const rolesShared = replication.distributed({
    entity: "role",
    port: withList ? reader.compose({ byId: findRole, list: listRoles }) : reader.compose({ byId: findRole }),
    namespace: "test:role",
    load: listRoles,
    startup: options.startup ?? "blocking",
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    ...(options.include === undefined ? {} : { include: options.include }),
    // The shared store holds the source's Role states.
    ...(withList
      ? {
          bind: ({ store }) => ({
            byId: (id: string) => store.get(id) as Promise<Role | undefined>,
            list: () => store.list() as Promise<readonly Role[]>,
          }),
        }
      : {}),
  });
  const roleReplication = replication({ roleReaders, rolesLocal, rolesShared });
  const save = command<Role>()({
    requirements: { saveRole },
    run: async (value, ctx) => success(await ctx.saveRole(value)),
  });
  return { database, reads, load, watchers, roleReaders, saves, localRoles, roleReplication, save };
}

type World = ReturnType<typeof world>;
type Store = ReturnType<typeof memoryStore>;
type Bus = ReturnType<typeof memoryBus>;

async function instance(w: World, store: Store, bus: Bus, shared: Lock, extra: readonly object[] = []) {
  const storeConnection = store.connect();
  const busConnection = bus.connect();
  const providers: readonly object[] = [
    ...Object.values(w.roleReplication),
    w.saves,
    w.save,
    w.roleReplication.health,
    healthProbes,
    unit({ provides: replicaStore, factory: () => storeConnection.store }),
    unit({ provides: replicationChannel, factory: () => busConnection.channel }),
    unit({ provides: lock, factory: () => shared }),
    ...extra,
  ];
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: providers.map((source) => ({ source })) })] }),
  );
  return {
    app,
    store: storeConnection,
    bus: busConnection,
    read: (id: string) => app.withScope((scope) => scope.resolve(findRole)(id)),
    save: (value: Role) => app.withScope((scope) => scope.resolve(w.save)(value)),
    local: () => app.withScope((scope) => scope.resolve(w.localRoles)),
    health: () =>
      app.withScope(async (scope) =>
        (await scope.resolve(w.roleReplication.health)).check({ signal: new AbortController().signal }),
      ),
  };
}

function setup(options: { readonly roles?: readonly Role[] } = {}) {
  const w = world();
  for (const value of options.roles ?? [role("r1", "admin")]) {
    w.database.set(value.id, value);
  }
  return { w, store: memoryStore(), bus: memoryBus(), shared: memoryLock() };
}

const isReady = (message: ReplicationMessage) => message.type === "ready";

function nextReload(w: World, local: Map<string, Role>): Promise<void> {
  return new Promise((resolve) => {
    const watch = (map: Map<string, Role>, changes: readonly CacheChange[]) => {
      if (map !== local || !changes.some((change) => change.type === "set")) {
        return;
      }
      w.watchers.delete(watch);
      resolve();
    };
    w.watchers.add(watch);
  });
}

test("stopped instances keep none of their layers or subscriptions reachable and leave no timer", async () => {
  const gc = (globalThis as { gc?: (options: object) => void }).gc ?? assert.fail("run with node --expose-gc");
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const before = timers();
  // The store, channel and lock outlive the instances, which they must not keep alive.
  const { w, store, bus, shared } = setup();
  const stopped = async () => {
    const ready = bus.next(isReady);
    const instances = await Promise.all([1, 2].map(() => instance(w, store, bus, shared)));
    await ready;
    await instances[0]!.save({ ...w.database.get("r1")!, name: "manager" });
    for (const each of instances) {
      await each.read("r1");
    }
    await Promise.all(instances.map((each) => each.app.stop()));
    return instances.map((each) => new WeakRef(each.app));
  };
  const applications = await stopped();
  // The current job keeps its objects alive until it ends, in the next turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  // A full collection: a single regular cycle can leave unreachable objects behind under load.
  gc({ type: "major", execution: "sync", flavor: "last-resort" });
  assert.deepEqual(
    applications.map((application) => application.deref()),
    [undefined, undefined],
  );
  assert.equal(timers(), before);
});

test("three instances hydrate an empty store once and read from it", async () => {
  const { w, store, bus, shared } = setup();
  const ready = bus.next(isReady);
  const instances = await Promise.all([1, 2, 3].map(() => instance(w, store, bus, shared)));
  try {
    await ready;
    for (const each of instances) {
      assert.equal((await each.read("r1"))?.name, "admin");
    }
    assert.equal(w.reads.list, 1);
    assert.equal(w.reads.byId, 0);
    assert.equal(store.markers.get("test:role:v1")?.state, "complete");
  } finally {
    await Promise.all(instances.map((each) => each.app.stop()));
  }
});

test("a write during hydration is not overwritten by the older load", async () => {
  const { w, store, bus, shared } = setup();
  const started = gate();
  const held = gate();
  w.load.started = started.open;
  w.load.held = held.opened;
  const leader = instance(w, store, bus, shared);
  await started.opened;
  const writer = await instance(w, store, bus, shared);
  await writer.save(role("r1", "root", 1));
  held.open();
  const hydrated = await leader;
  try {
    assert.equal((await hydrated.read("r1"))?.version, 2);
    assert.equal(w.reads.byId, 0);
  } finally {
    await Promise.all([hydrated.app.stop(), writer.app.stop()]);
  }
});

test("an instance that missed ready catches up on its next commit", async () => {
  const { w, store, bus, shared } = setup();
  const started = gate();
  const held = gate();
  w.load.started = started.open;
  w.load.held = held.opened;
  const leading = instance(w, store, bus, shared);
  await started.opened;
  const late = await instance(w, store, bus, shared);
  late.bus.drop("ready");
  held.open();
  const leader = await leading;
  try {
    await late.read("r1");
    assert.equal(w.reads.byId, 1);
    await late.save(role("r1", "root", 1));
    assert.equal((await late.read("r1"))?.version, 2);
    assert.equal(w.reads.byId, 1);
  } finally {
    await Promise.all([leader.app.stop(), late.app.stop()]);
  }
});

test("a failed hydration is retried by the next instance that starts", async () => {
  const { w, store, bus, shared } = setup();
  w.load.failures = 1;
  const failed = await instance(w, store, bus, shared);
  try {
    assert.equal(await failed.health(), "down");
    assert.equal(store.markers.get("test:role:v1")?.state, "loading");
    const ready = bus.next(isReady);
    const next = await instance(w, store, bus, shared);
    try {
      await ready;
      assert.equal(await failed.health(), "up");
      assert.equal((await failed.read("r1"))?.name, "admin");
      assert.equal(w.reads.byId, 0);
      assert.equal(w.reads.list, 2);
    } finally {
      await next.app.stop();
    }
  } finally {
    await failed.app.stop();
  }
});

test("a restarted store is hydrated again once the channel is restored", async () => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const b = await instance(w, store, bus, shared);
  try {
    store.restart();
    a.bus.lose();
    b.bus.lose();
    const ready = bus.next(isReady);
    const reloaded = nextReload(w, await b.local());
    a.bus.restore();
    b.bus.restore();
    await ready;
    await reloaded;
    assert.equal(store.markers.get("test:role:v1")?.state, "complete");
    assert.equal((await b.read("r1"))?.name, "admin");
    assert.equal(w.reads.list, 2);
    assert.equal(w.reads.byId, 0);
  } finally {
    await Promise.all([a.app.stop(), b.app.stop()]);
  }
});

test("a new revision takes over while instances on the old one read the source", async () => {
  const database = new Map([["r1", role("r1", "admin")]]);
  const old = world({ database });
  const current = world({ database, revision: 2 });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const a = await instance(old, store, bus, shared);
  const b = await instance(current, store, bus, shared);
  try {
    assert.equal(store.spaces.has("test:role:v1"), false);
    assert.equal(store.markers.get("test:role:v2")?.state, "complete");
    await a.read("r1");
    assert.equal(old.reads.byId, 1);
    const adopted = bus.next((message) => message.type === "changes" && message.keyspace === "test:role:v2");
    await a.save(role("r1", "root", 1));
    await adopted;
    assert.equal((await b.read("r1"))?.version, 2);
    assert.equal(current.reads.byId, 1);
  } finally {
    await Promise.all([a.app.stop(), b.app.stop()]);
  }
});

test("the most recently started refresh of a key wins", async () => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const b = await instance(w, store, bus, shared);
  try {
    const bLocal = await b.local();
    const stale = b.store.holdNextGet();
    await a.save(role("r1", "root", 1));
    await stale.reading;
    const refreshed = new Promise<void>((resolve) => {
      w.watchers.add((local, changes) => {
        const newest = changes.some((change) => change.type === "set" && (change.value as Role).version === 3);
        if (local === bLocal && newest) {
          resolve();
        }
      });
    });
    await a.save(role("r1", "root", 2));
    await refreshed;
    stale.release();
    assert.equal(bLocal.get("r1")?.version, 3);
    assert.equal((await b.read("r1"))?.version, 3);
  } finally {
    await Promise.all([a.app.stop(), b.app.stop()]);
  }
});

test("a read after a local commit sees the committed state", async () => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  try {
    assert.equal((await a.local()).get("r1")?.version, 1);
    await a.save(role("r1", "root", 1));
    assert.equal((await a.read("r1"))?.version, 2);
    assert.equal(w.reads.byId, 0);
  } finally {
    await a.app.stop();
  }
});

test("missing contracts fail at startup", async () => {
  const { w } = setup();
  const definitions: readonly object[] = [...Object.values(w.roleReplication), w.saves];
  await assert.rejects(
    runApplication(
      defineApplication({ modules: [composeModule({ providers: definitions.map((source) => ({ source })) })] }),
    ),
    (error: Error) => /contract|implementation|requires/i.test(String(error)),
  );
});

test("a commit on a hydrating instance does not wait for the load", { timeout: 10_000 }, async () => {
  const w = world({ startup: "background" });
  const started = gate();
  const held = gate();
  w.load.started = started.open;
  w.load.held = held.opened;
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const leader = await instance(w, store, bus, shared);
  await started.opened;
  // The load gate stays closed until the command has settled.
  await leader.save(role("r1", "root", 0));
  held.open();
  await leader.app.stop();
});

test(
  "a commit on an instance whose store is not current starts the hydration without waiting for it",
  {
    timeout: 10_000,
  },
  async () => {
    const { w, store, bus, shared } = setup();
    w.load.failures = 1;
    const failed = await instance(w, store, bus, shared);
    try {
      assert.equal(store.markers.get("test:role:v1")?.state, "loading");
      const started = gate();
      const held = gate();
      w.load.started = started.open;
      w.load.held = held.opened;
      // The load gate stays closed until the command has settled.
      await failed.save(role("r1", "root", 1));
      await started.opened;
      const local = await failed.local();
      const reloaded = new Promise<void>((resolve) => {
        w.watchers.add((map, changes) => {
          if (map === local && changes.some((change) => change.type === "set")) {
            resolve();
          }
        });
      });
      held.open();
      await reloaded;
      assert.equal(w.reads.list, 2);
      assert.equal(store.markers.get("test:role:v1")?.state, "complete");
      assert.equal(await failed.health(), "up");
      assert.equal((await failed.read("r1"))?.version, 2);
      assert.equal(w.reads.byId, 0);
    } finally {
      await failed.app.stop();
    }
  },
);

test("rebuild() during an in-flight readiness check rebuilds", { timeout: 10_000 }, async () => {
  const w = world({ startup: "background" });
  w.database.set("r1", role("r1", "admin"));
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const hydrated = bus.next(isReady);
  const first = await instance(w, store, bus, shared);
  await hydrated;
  assert.equal(store.markers.get("test:role:v1")?.state, "complete");
  assert.equal(w.reads.list, 1);
  const check = store.holdNextMarker();
  const second = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
  try {
    await check.reading;
    const rebuild = await second.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild));
    const rebuilt = rebuild();
    check.release();
    await rebuilt;
    // The check found the store current; only the forced rebuild loads the source again.
    assert.equal(w.reads.list, 2);
    assert.equal(store.markers.get("test:role:v1")?.state, "complete");
  } finally {
    await Promise.all([first.app.stop(), second.app.stop()]);
  }
});

test("stop during a hydration returns after the current page", { timeout: 10_000 }, async () => {
  const w = world({ startup: "background" });
  for (const value of [role("r1", "admin"), role("r2", "editor"), role("r3", "viewer")]) {
    w.database.set(value.id, value);
  }
  w.load.pages = 3;
  const store = memoryStore();
  const firstPage = store.holdNextApply();
  const locks = memoryLock();
  const hydrating = await instance(w, store, memoryBus(), locks);
  await firstPage.reading;
  const stopped = hydrating.app.stop();
  await hydrating.bus.closed;
  firstPage.release();
  await stopped;
  // The stopped instance released its hydration lock, so another instance can take it at once.
  assert.equal(locks.leases.length, 1);
  assert.deepEqual(await locks.tryRun("test:role:v1:hydration", { leaseMs: 1_000 }, async () => "free"), {
    acquired: true,
    value: "free",
  });
  assert.equal(store.applies.length, 1);
  assert.notEqual(store.markers.get("test:role:v1")?.state, "complete");
  assert.equal(hydrating.bus.published.filter(isReady).length, 0);
});

test(
  "a hydration whose lease expired cannot complete after another instance took over",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ startup: "background" });
    const older = role("r1", "older");
    const newer = role("r1", "newer", 2);
    w.database.set("r1", older);
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const aGate = gate();
    const bGate = gate();
    const aStarted = gate();
    const bStarted = gate();
    w.load.gates.push(aGate.opened, bGate.opened);
    w.load.started = aStarted.open;
    const a = await instance(w, store, bus, shared);
    const instances = [a];
    try {
      await aStarted.opened;
      const aLease = shared.leases[0];
      assert.ok(aLease);
      shared.expire("test:role:v1:hydration");
      w.database.set("r1", newer);
      w.load.started = bStarted.open;
      const b = await instance(w, store, bus, shared);
      instances.push(b);
      await bStarted.opened;
      const bLease = shared.leases[1];
      assert.ok(bLease);
      const bHolder = store.markers.get("test:role:v1")?.holder;
      assert.equal(typeof bHolder, "string");

      aGate.open();
      await aLease.finished;
      const beforeB = {
        marker: store.markers.get("test:role:v1"),
        applied: store.applies.flatMap((changes) => changes.map((change) => change.value)),
        read: await a.read("r1"),
        sourceReads: w.reads.byId,
        health: await a.health(),
      };
      const ready = bus.next(isReady);
      const reloaded = nextReload(w, await a.local());
      bGate.open();
      await ready;
      await bLease.finished;
      await reloaded;
      const observed = {
        beforeB,
        marker: store.markers.get("test:role:v1"),
        readyCount: [a, b].flatMap((each) => each.bus.published).filter(isReady).length,
        applied: store.applies.flatMap((changes) => changes.map((change) => change.value)),
        read: await a.read("r1"),
        sourceReads: w.reads.byId,
      };
      t.diagnostic(JSON.stringify(observed));
      const runId = await a.store.store.runId();
      assert.deepEqual(observed, {
        beforeB: {
          marker: { state: "loading", dirty: false, runId, holder: bHolder },
          applied: [],
          read: newer,
          sourceReads: 1,
          health: "up",
        },
        marker: { state: "complete", dirty: false, runId, holder: bHolder },
        readyCount: 1,
        applied: [newer],
        read: newer,
        sourceReads: 1,
      });
    } finally {
      aGate.open();
      bGate.open();
      await Promise.all(instances.map((each) => each.app.stop()));
    }
  },
);

test("a dirty mark from another instance does not fence the holder", { timeout: 10_000 }, async (t) => {
  const w = world({ startup: "background" });
  const original = role("r1", "admin");
  w.database.set("r1", original);
  const follower = world({ database: w.database });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const held = gate();
  const started = gate();
  w.load.gates.push(held.opened);
  w.load.started = started.open;
  const a = await instance(w, store, bus, shared);
  const instances = [a];
  try {
    await started.opened;
    const lease = shared.leases[0];
    assert.ok(lease);
    const holder = store.markers.get("test:role:v1")?.holder;
    assert.equal(typeof holder, "string");
    const b = await instance(follower, store, bus, shared);
    instances.push(b);
    const c = await instance(follower, store, bus, shared);
    instances.push(c);
    // Keep the dirty follower from requesting another rebuild on the holder's ready message.
    c.bus.drop("ready");
    c.store.failNextApply();
    await c.save(role("r2", "editor", 0));
    await c.save(role("r2", "editor", 1));
    const dirtyMarker = store.markers.get("test:role:v1");
    const runId = await c.store.store.runId();
    // A store consumer may also omit the holder on an unfenced dirty mark.
    await c.store.store.mark("test:role:v1", { state: "loading", dirty: true, runId });
    const withoutHolder = store.markers.get("test:role:v1");
    const ready = bus.next(isReady);
    const reloaded = nextReload(w, await a.local());
    held.open();
    await ready;
    await lease.finished;
    await reloaded;
    const observed = {
      dirtyMarker,
      withoutHolder,
      marker: store.markers.get("test:role:v1"),
      readyCount: instances.flatMap((each) => each.bus.published).filter(isReady).length,
      applied: store.applies.flatMap((changes) => changes.map((change) => change.value)),
      read: await a.read("r1"),
      sourceReads: w.reads.byId,
    };
    t.diagnostic(JSON.stringify(observed));
    assert.deepEqual(observed, {
      dirtyMarker: { state: "loading", dirty: true, runId, holder },
      withoutHolder: { state: "loading", dirty: true, runId, holder },
      marker: { state: "complete", dirty: false, runId, holder },
      readyCount: 1,
      applied: [role("r2", "editor", 2), original],
      read: original,
      sourceReads: 0,
    });
  } finally {
    held.open();
    await Promise.all(instances.map((each) => each.app.stop()));
  }
});

test(
  "a delayed third-instance dirty mark must not restore an expired holder over a live successor",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ startup: "background" });
    const older = role("r1", "older");
    const newer = role("r1", "newer", 2);
    const editor = role("r2", "editor", 2);
    w.database.set("r1", older);
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const aGate = gate();
    const bGate = gate();
    const aStarted = gate();
    const bStarted = gate();
    let dirtyMark: ReturnType<typeof store.holdNextMark> | undefined;
    w.load.gates.push(aGate.opened, bGate.opened);
    w.load.started = aStarted.open;
    const a = await instance(w, store, bus, shared);
    const instances = [a];
    try {
      await aStarted.opened;
      const aLease = shared.leases[0];
      assert.ok(aLease);
      const c = await instance(world({ database: w.database }), store, bus, shared);
      instances.push(c);
      c.bus.drop("ready");
      c.store.failNextApply();
      await c.save(role("r2", "editor", 0));
      dirtyMark = store.holdNextMark();
      const saving = c.save(role("r2", "editor", 1));
      await dirtyMark.reading;

      shared.expire("test:role:v1:hydration");
      w.database.set("r1", newer);
      w.load.started = bStarted.open;
      const b = await instance(w, store, bus, shared);
      instances.push(b);
      await bStarted.opened;
      const bLease = shared.leases[1];
      assert.ok(bLease);
      const bHolder = store.markers.get("test:role:v1")?.holder;
      assert.equal(typeof bHolder, "string");
      const beforeDirty = store.markers.get("test:role:v1");
      dirtyMark.release();
      await saving;
      const afterDirty = store.markers.get("test:role:v1");
      const aReloaded = nextReload(w, await a.local());
      const bReloaded = nextReload(w, await b.local());
      bGate.open();
      await bLease.finished;
      await bReloaded;
      const afterB = store.markers.get("test:role:v1");
      aGate.open();
      await aLease.finished;
      await aReloaded;
      const observed = {
        aToken: aLease.token,
        bToken: bLease.token,
        beforeDirty,
        afterDirty,
        afterB,
        finalMarker: store.markers.get("test:role:v1"),
        applied: store.applies.flatMap((changes) => changes.map((change) => change.value)),
        readyCount: instances.flatMap((each) => each.bus.published).filter(isReady).length,
        aReadyCount: a.bus.published.filter(isReady).length,
        bReadyCount: b.bus.published.filter(isReady).length,
        reads: [await a.read("r1"), await b.read("r1")],
        sourceReads: w.reads.byId,
      };
      t.diagnostic(JSON.stringify(observed));
      assert.equal(beforeDirty?.holder, bHolder);
      assert.equal(
        afterDirty?.holder,
        bHolder,
        "dirty mark must preserve the live B holder instead of restoring expired A",
      );
      assert.equal(afterDirty?.dirty, true);
      const runId = await b.store.store.runId();
      const complete = { state: "complete", dirty: false, runId, holder: bHolder };
      assert.deepEqual(afterB, complete);
      assert.deepEqual(observed.finalMarker, complete);
      assert.deepEqual(observed.applied, [editor, newer, editor]);
      assert.equal(observed.readyCount, 1);
      assert.equal(observed.aReadyCount, 0);
      assert.equal(observed.bReadyCount, 1);
      assert.deepEqual(observed.reads, [newer, newer]);
      assert.equal(observed.sourceReads, 0);
    } finally {
      dirtyMark?.release();
      aGate.open();
      bGate.open();
      await Promise.all(instances.map((each) => each.app.stop()));
    }
  },
);

test(
  "a lost store connection sends reads to the source and the restored connection rechecks the marker",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    t.after(async () => {
      a.store.restore();
      await a.app.stop();
      assert.equal(a.store.watchers.size, 0);
    });
    const originalRun = store.markers.get("test:role:v1")?.runId;
    a.store.lose();
    const calls = a.store.calls.length;
    w.database.set("r1", role("r1", "newer", 2));
    assert.equal((await a.read("r1"))?.name, "newer");
    assert.equal(w.reads.byId, 1);
    assert.equal(a.store.calls.length, calls);
    assert.equal((await a.local()).size, 0);
    store.restart();
    const ready = bus.next(isReady);
    const reloaded = nextReload(w, await a.local());
    a.store.restore();
    await ready;
    await reloaded;
    assert.notEqual(store.markers.get("test:role:v1")?.runId, originalRun);
    assert.equal(store.markers.get("test:role:v1")?.state, "complete");
    assert.equal((await a.read("r1"))?.name, "newer");
    assert.equal(w.reads.byId, 1);
    assert.equal(w.reads.list, 2);
  },
);

test("after a read failure the next read rechecks readiness", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const checking = store.holdNextMarker();
  t.after(async () => {
    checking.release();
    await a.app.stop();
  });
  // A miss in the instance layer reaches the real shared read wrapper.
  (await a.local()).clear();
  a.store.failNextGet();
  assert.equal((await a.read("r1"))?.name, "admin");
  assert.equal(w.reads.byId, 1);
  const reloaded = nextReload(w, await a.local());
  assert.equal((await a.read("r1"))?.name, "admin");
  await checking.reading;
  const calls = a.store.calls.length;
  await a.read("r1");
  assert.equal(a.store.calls.length, calls, "an in-flight check is shared by fallback reads");
  checking.release();
  await reloaded;
  const sourceReads = w.reads.byId;
  (await a.local()).clear();
  assert.equal((await a.read("r1"))?.name, "admin");
  assert.equal(w.reads.byId, sourceReads);
  assert.equal(w.reads.list, 1);
});

test(
  "a commit during a store outage settles without touching the store and the restored connection rebuilds",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    const outage = a.store.lose();
    // The test deadline only releases a regressed native wait for cleanup; it never makes the test pass.
    t.signal.addEventListener("abort", outage.release, { once: true });
    t.after(async () => {
      a.store.restore();
      await a.app.stop();
    });
    const calls = a.store.calls.length;
    const publications = a.bus.published.length;
    const saved = await a.save(role("r1", "outage change", 1));
    assert.equal(saved.isError, false);
    assert.equal(a.store.calls.length, calls);
    assert.equal(a.bus.published.length, publications);
    assert.deepEqual(w.database.get("r1"), role("r1", "outage change", 2));
    const ready = bus.next(isReady);
    const reloaded = nextReload(w, await a.local());
    a.store.restore();
    await ready;
    await reloaded;
    assert.equal(w.reads.list, 2);
    assert.deepEqual(await a.store.store.get("test:role:v1", "role", "r1"), role("r1", "outage change", 2));
    assert.equal((await a.read("r1"))?.name, "outage change");
    assert.equal(w.reads.byId, 0);
  },
);

test("an outage traces once", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const failures: unknown[] = [];
  const tracing: Tracing = {
    async run(span, work) {
      if (span.name === "test:role replication failed") {
        failures.push(span.failure?.(undefined));
      }
      return work();
    },
    capture: () => undefined,
    bind: (work) => work,
  };
  const a = await instance(w, store, bus, shared, [unit({ provides: trace, factory: () => tracing })]);
  t.after(() => a.app.stop());
  a.store.failNextApply();
  await a.save(role("r1", "first failure", 1));
  a.store.failNextApply();
  await a.save(role("r1", "same outage", 2));
  assert.equal(failures.length, 1);
  assert.equal(await a.health(), "down");
  const ready = bus.next(isReady);
  const reloaded = nextReload(w, await a.local());
  await a.save(role("r1", "recovered", 3));
  await ready;
  await reloaded;
  assert.equal(await a.health(), "up");
  a.store.failNextApply();
  await a.save(role("r1", "second outage", 4));
  a.store.failNextApply();
  await a.save(role("r1", "same second outage", 5));
  assert.equal(failures.length, 2);
});

/** The state of an entity as the shared store holds it in a keyspace. */
function stored(store: Store, keyspace: string, id: string): Promise<unknown> {
  return store.connect().store.get(keyspace, "role", id);
}

/** A v2 rollout in progress: its marker is `loading` and its hydration lock is held until the returned call. */
async function rolloutInProgress(store: Store, shared: Lock): Promise<() => Promise<void>> {
  const finished = gate();
  const holding = shared.tryRun("test:role:v2:hydration", { leaseMs: 60_000 }, () => finished.opened);
  const connection = store.connect().store;
  await connection.mark("test:role:v2", { state: "loading", dirty: false, runId: await connection.runId() });
  return async () => {
    finished.open();
    await holding;
  };
}

test(
  "an older instance suspends on a newer revision and keeps its keyspace current until it completes",
  {
    timeout: 10_000,
  },
  async () => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const current = world({ database, revision: 2 });
    const started = gate();
    const held = gate();
    current.load.started = started.open;
    current.load.held = held.opened;
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const a = await instance(old, store, bus, shared);
    // Dropped by the v2 hydration and by the superseded instance, in either order.
    const superseded = store.dropped("test:role:v1", 2);
    const starting = instance(current, store, bus, shared);
    try {
      await started.opened;
      assert.equal((await a.local()).size, 0);
      assert.equal((await a.read("r1"))?.name, "admin");
      assert.equal(old.reads.byId, 1);
      await a.save(role("r1", "root", 1));
      assert.deepEqual(await stored(store, "test:role:v1", "r1"), role("r1", "root", 2));
      held.open();
      await superseded;
      const b = await starting;
      assert.equal(store.markers.get("test:role:v2")?.state, "complete");
      assert.equal(store.spaces.has("test:role:v1"), false);
      const applies = a.store.calls.filter((call) => call === "apply").length;
      const adopted = bus.next(
        (message) =>
          message.type === "changes" &&
          message.keyspace === "test:role:v2" &&
          message.changes.some((change) => change.order === 3),
      );
      await a.save(role("r1", "root", 2));
      await adopted;
      assert.equal(a.store.calls.filter((call) => call === "apply").length, applies);
      assert.equal(store.spaces.has("test:role:v1"), false);
      const published = a.bus.published.at(-1);
      assert.ok(published?.type === "changes");
      assert.equal(published.keyspace, "test:role:v1");
      assert.deepEqual(published.changes, [{ entity: "role", id: "r1", order: 3, type: "set" }]);
      assert.equal((await b.read("r1"))?.version, 3);
    } finally {
      held.open();
      await Promise.all([a.app.stop(), (await starting).app.stop()]);
    }
  },
);

test(
  "an older instance that starts during a rollout loads nothing and keeps its keyspace current",
  {
    timeout: 10_000,
  },
  async () => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const finishRollout = await rolloutInProgress(store, shared);
    const a = await instance(old, store, bus, shared);
    try {
      assert.equal((await a.read("r1"))?.name, "admin");
      assert.equal(old.reads.byId, 1);
      await a.save(role("r1", "root", 1));
      assert.deepEqual(await stored(store, "test:role:v1", "r1"), role("r1", "root", 2));
    } finally {
      await a.app.stop();
      await finishRollout();
    }
    assert.equal(old.reads.list, 0);
    assert.deepEqual(a.bus.published.filter(isReady), []);
    assert.equal(store.markers.get("test:role:v2")?.state, "loading");
  },
);

test(
  "a newer revision's ready message supersedes nothing while its marker is still loading",
  {
    timeout: 10_000,
  },
  async () => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const a = await instance(old, store, bus, shared);
    const local = await a.local();
    const finishRollout = await rolloutInProgress(store, shared);
    try {
      await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v2" });
      assert.equal(local.size, 0);
      // A peer's ready on this keyspace does not reload the instance layer during the suspension.
      await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v1" });
      assert.equal((await a.read("r1"))?.name, "admin");
      assert.equal(old.reads.byId, 1);
      await a.save(role("r1", "root", 1));
      assert.deepEqual(await stored(store, "test:role:v1", "r1"), role("r1", "root", 2));
    } finally {
      await a.app.stop();
      await finishRollout();
    }
    assert.equal(local.size, 0);
    assert.deepEqual(await stored(store, "test:role:v1", "r1"), role("r1", "root", 2));
    assert.equal(store.markers.get("test:role:v1")?.state, "complete");
    assert.equal(store.markers.get("test:role:v2")?.state, "loading");
  },
);

test(
  "an abandoned newer revision lets older instances resume after a rebuild",
  {
    timeout: 10_000,
  },
  async () => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const a = await instance(old, store, bus, shared);
    try {
      const runId = await a.store.store.runId();
      await a.store.store.mark("test:role:v2", { state: "loading", dirty: false, runId });
      const ready = bus.next((message) => message.type === "ready" && message.keyspace === "test:role:v1");
      const reloaded = nextReload(old, await a.local());
      await a.bus.channel.publish({
        type: "changes",
        origin: "external",
        keyspace: "test:role:v2",
        changes: [],
      });
      await ready;
      await reloaded;
      assert.equal(store.markers.get("test:role:v2"), undefined);
      assert.equal(store.markers.get("test:role:v1")?.state, "complete");
      assert.equal((await a.read("r1"))?.name, "admin");
      assert.equal(old.reads.byId, 0);
    } finally {
      await a.app.stop();
    }
  },
);

/** A lock that runs a step of the test each time a hydration lock is asked for, before the lock answers. */
function lockWith(inner: Lock, step: (name: string) => void | Promise<void>): Lock {
  return {
    async tryRun(name, options, work) {
      await step(name);
      return inner.tryRun(name, options, work);
    },
  };
}

async function markRevision(store: Store, keyspace: string, state: "loading" | "complete"): Promise<void> {
  const connection = store.connect().store;
  await connection.mark(keyspace, { state, dirty: false, runId: await connection.runId() });
}

test("a higher revision seen during a review is not discarded", { timeout: 10_000 }, async () => {
  const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const reviewedV3 = gate();
  const a = await instance(
    old,
    store,
    bus,
    lockWith(shared, (name) => {
      if (name === "test:role:v3:hydration") {
        reviewedV3.open();
      }
    }),
  );
  const rebuilt = gate();
  old.load.started = rebuilt.open;
  const reviewOfV2 = store.holdMarkerRead("test:role:v2", 1);
  await a.bus.channel.publish({ type: "changes", origin: "external", keyspace: "test:role:v2", changes: [] });
  await reviewOfV2.reading;
  const finished = gate();
  const holding = shared.tryRun("test:role:v3:hydration", { leaseMs: 60_000 }, () => finished.opened);
  await markRevision(store, "test:role:v3", "loading");
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v3" });
  try {
    reviewOfV2.release();
    await Promise.race([reviewedV3.opened, rebuilt.opened]);
    assert.equal(old.reads.list, 1);
    assert.equal((await a.read("r1"))?.name, "admin");
    assert.equal(old.reads.byId, 1);
  } finally {
    await a.app.stop();
    finished.open();
    await holding;
  }
  assert.equal(old.reads.list, 1);
  assert.equal(a.bus.published.filter(isReady).length, 1);
  assert.equal(store.markers.get("test:role:v3")?.state, "loading");
});

test("a ready during an in-flight review is not lost", { timeout: 10_000 }, async () => {
  const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const contended = gate();
  const proceed = gate();
  const a = await instance(
    old,
    store,
    bus,
    lockWith(shared, async (name) => {
      if (name !== "test:role:v2:hydration") {
        return;
      }
      contended.open();
      await proceed.opened;
    }),
  );
  const finishRollout = await rolloutInProgress(store, shared);
  const superseded = store.dropped("test:role:v1", 1);
  try {
    await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
    await contended.opened;
    await markRevision(store, "test:role:v2", "complete");
    await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v2" });
    proceed.open();
    await superseded;
    assert.equal(store.spaces.has("test:role:v1"), false);
    assert.equal(old.reads.list, 1);
  } finally {
    await a.app.stop();
    await finishRollout();
  }
});

test("a marker completed before the lock supersedes instead of resuming", { timeout: 10_000 }, async () => {
  const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const a = await instance(
    old,
    store,
    bus,
    lockWith(shared, async (name) => {
      if (name === "test:role:v2:hydration") {
        await markRevision(store, "test:role:v2", "complete");
      }
    }),
  );
  const rebuilt = gate();
  old.load.started = rebuilt.open;
  await markRevision(store, "test:role:v2", "loading");
  const superseded = store.dropped("test:role:v1", 1);
  try {
    await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
    await Promise.race([superseded, rebuilt.opened]);
    assert.equal(old.reads.list, 1);
    assert.equal(store.markers.get("test:role:v2")?.state, "complete");
  } finally {
    await a.app.stop();
  }
});

test("stop drains a review that is dropping an abandoned rollout", { timeout: 10_000 }, async () => {
  const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const a = await instance(old, store, bus, shared);
  await markRevision(store, "test:role:v2", "loading");
  // The second read is the one inside the rollout's lock, past the review's stopped check.
  const insideLock = store.holdMarkerRead("test:role:v2", 2);
  // A stop that does not drain the review returns before this round trip ends, with the rollout still there. A gate
  // cannot show that: held until stop returns it deadlocks a correct stop, and opened on reaching the drop it lets the
  // non-draining stop pass, because the test runs on before that stop returns.
  const nativeDrop = a.store.store.drop;
  a.store.store.drop = async (keyspace) => {
    await roundTrip();
    return nativeDrop(keyspace);
  };
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
  await insideLock.reading;
  const stopped = a.app.stop();
  await a.bus.closed;
  insideLock.release();
  await stopped;
  assert.equal(store.markers.has("test:role:v2"), false);
  const free = await shared.tryRun("test:role:v2:hydration", { leaseMs: 60_000 }, async () => undefined);
  assert.equal(free.acquired, true);
  assert.equal(old.reads.list, 1);
});

test("a review overtaken by stop takes no lock and keeps the rollout", { timeout: 10_000 }, async () => {
  const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const a = await instance(old, store, bus, shared);
  const leases = shared.leases.length;
  await markRevision(store, "test:role:v2", "loading");
  const firstRead = store.holdMarkerRead("test:role:v2", 1);
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
  await firstRead.reading;
  const stopped = a.app.stop();
  await a.bus.closed;
  firstRead.release();
  await stopped;
  assert.equal(shared.leases.length, leases);
  assert.equal(store.markers.get("test:role:v2")?.state, "loading");
});

const unordered = "unordered";
const withoutVersion = ({ entity, id, name }: Role) => ({ entity, id, name }) as unknown as Role;

/** The replication of `w` over a writer that stores a role named `unordered` without the version its type promises. */
function withUnordered(w: World): World {
  return {
    ...w,
    saves: plug({
      port: saveRole,
      bind: () => async (value: Role) => {
        const stored = value.name === unordered ? withoutVersion(value) : { ...value, version: value.version + 1 };
        w.database.set(value.id, stored);
        return upserted(stored);
      },
    }),
  };
}

function failureTraces() {
  const failures: unknown[] = [];
  const waiters: (() => void)[] = [];
  const tracing: Tracing = {
    async run(span, work) {
      if (span.name === "test:role replication failed") {
        failures.push(span.failure?.(undefined));
        for (const resolve of waiters.splice(0)) {
          resolve();
        }
      }
      return work();
    },
    capture: () => undefined,
    bind: (work) => work,
  };
  return {
    failures,
    provider: unit({ provides: trace, factory: () => tracing }),
    /** Resolves on the next failure span; call it before the action that fails. */
    next: () => new Promise<void>((resolve) => waiters.push(resolve)),
  };
}

const keyOf = (id: string, order: number) => ({ entity: "role", id, order, type: "set" as const });

/** The delivered `changes` messages of a connection on a keyspace, by value. */
function changesOn(connection: { readonly published: readonly ReplicationMessage[] }, keyspace = "test:role:v1") {
  return connection.published.flatMap((message) =>
    message.type === "changes" && message.keyspace === keyspace ? [message.changes] : [],
  );
}

const changeAttempts = (connection: { readonly attempts: readonly ReplicationMessage[] }) =>
  connection.attempts.filter((message) => message.type === "changes").length;

const visible = (state: unknown) => (state as Role).name !== "hidden";

type Running = Awaited<ReturnType<typeof instance>>;

const listFrom = (each: Running) => each.app.withScope((scope) => scope.resolve(listRoles)());

/** Stopping drains in-flight publishes, so the health afterwards reflects their outcome. */
async function healthAfterStop(w: World, each: Running): Promise<unknown> {
  const check = await each.app.withScope((scope) => scope.resolve(w.roleReplication.health));
  await each.app.stop();
  return check.check({ signal: new AbortController().signal });
}

test("a failed publish is retried with the next one without a rebuild", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const b = await instance(w, store, bus, shared);
  t.after(() => Promise.all([a.app.stop(), b.app.stop()]));
  const bLocal = await b.local();
  const received = new Promise<void>((resolve) => {
    w.watchers.add((local) => {
      if (local === bLocal && local.get("r1")?.version === 2 && local.has("r2")) {
        resolve();
      }
    });
  });
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await a.save(role("r2", "editor", 0));
  await received;
  await Promise.all([a.app.stop(), b.app.stop()]);
  assert.deepEqual(
    {
      loads: w.reads.list,
      changes: changesOn(a.bus),
      dirty: store.markers.get("test:role:v1")?.dirty,
      received: [bLocal.get("r1"), bLocal.get("r2")],
    },
    {
      loads: 1,
      changes: [[keyOf("r1", 2), keyOf("r2", 1)]],
      dirty: false,
      received: [role("r1", "root", 2), role("r2", "editor", 1)],
    },
  );
});

test("a state without an order disables the replication instead of rebuilding", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(withUnordered(w), store, bus, shared, [traces.provider]);
  t.after(() => a.app.stop());
  const calls = a.store.calls.length;
  const attempts = a.bus.attempts.length;
  await a.save(role("r1", unordered, 1));
  await a.save(role("r1", "versioned again", 1));
  const health = await a.health();
  const read = await a.read("r1");
  const local = (await a.local()).size;
  const storeCalls = a.store.calls.slice(calls);
  const publishes = a.bus.attempts.length - attempts;
  await a.app.stop();
  assert.deepEqual(
    {
      loads: w.reads.list,
      health,
      read,
      sourceReads: w.reads.byId,
      local,
      storeCalls,
      publishes,
      failures: traces.failures.map((failure) => (failure as Error).name),
      stored: await stored(store, "test:role:v1", "r1"),
    },
    {
      loads: 1,
      health: "down",
      read: role("r1", "versioned again", 2),
      sourceReads: 1,
      local: 0,
      storeCalls: [],
      publishes: 0,
      failures: ["TypeError"],
      stored: role("r1", "admin"),
    },
  );
});

test("a shared layer with include answers absence from the source", { timeout: 10_000 }, async (t) => {
  const w = world({ include: visible });
  w.database.set("r1", role("r1", "admin"));
  w.database.set("r2", role("r2", "hidden"));
  const store = memoryStore();
  const a = await instance(w, store, memoryBus(), memoryLock());
  t.after(() => a.app.stop());
  assert.equal(await stored(store, "test:role:v1", "r2"), undefined);
  assert.equal((await a.read("r1"))?.name, "admin");
  assert.equal(w.reads.byId, 0);
  assert.deepEqual(await a.read("r2"), role("r2", "hidden"));
  assert.equal(w.reads.byId, 1);
});

test("a list through a shared layer with include is read from the source", { timeout: 10_000 }, async (t) => {
  const w = world({ include: visible, members: { list: true } });
  w.database.set("r1", role("r1", "admin"));
  w.database.set("r2", role("r2", "hidden"));
  const a = await instance(w, memoryStore(), memoryBus(), memoryLock());
  t.after(() => a.app.stop());
  assert.equal(w.reads.list, 1);
  assert.deepEqual(await listFrom(a), [role("r1", "admin"), role("r2", "hidden")]);
  assert.equal(w.reads.list, 2);
});

test("an instance-layer list with include is read from the next layer", { timeout: 10_000 }, async (t) => {
  const w = world({ localInclude: visible, members: { list: true } });
  w.database.set("r1", role("r1", "admin"));
  w.database.set("r2", role("r2", "hidden"));
  const a = await instance(w, memoryStore(), memoryBus(), memoryLock());
  t.after(() => a.app.stop());
  assert.deepEqual([...(await a.local()).keys()], ["r1"]);
  assert.deepEqual(await listFrom(a), [role("r1", "admin"), role("r2", "hidden")]);
  assert.equal(a.store.calls.filter((call) => call === "list").length, 2);
  assert.equal(w.reads.list, 1);
});

test(
  "an instance-layer list inside a Unit of Work that wrote the entity is read from the next layer",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ members: { list: true } });
    w.database.set("r1", role("r1", "admin"));
    const saveThenList = command<Role>()({
      requirements: { saveRole, listRoles },
      run: async (value, ctx) => {
        await ctx.saveRole(value);
        return success(await ctx.listRoles());
      },
    });
    const a = await instance(w, memoryStore(), memoryBus(), memoryLock(), [saveThenList]);
    t.after(() => a.app.stop());
    const storeLists = a.store.calls.filter((call) => call === "list").length;
    assert.deepEqual(await listFrom(a), [role("r1", "admin")]);
    assert.equal(a.store.calls.filter((call) => call === "list").length, storeLists);
    assert.equal(w.reads.list, 1);
    const inside = await a.app.withScope((scope) => scope.resolve(saveThenList)(role("r2", "editor", 0)));
    assert.ok(!inside.isError);
    assert.deepEqual(inside.value, [role("r1", "admin"), role("r2", "editor", 1)]);
    assert.equal(w.reads.list, 2);
  },
);

test("commits while suspended still publish their keys", { timeout: 10_000 }, async (t) => {
  const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const a = await instance(old, store, bus, shared);
  const finishRollout = await rolloutInProgress(store, shared);
  t.after(async () => {
    await a.app.stop();
    await finishRollout();
  });
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
  await a.save(role("r1", "root", 1));
  await a.app.stop();
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
  assert.deepEqual(await stored(store, "test:role:v1", "r1"), role("r1", "root", 2));
});

test("a missing order disables only its own replication", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(withUnordered(w), store, bus, shared);
  // Created last, from the same definition.
  const b = await instance(w, store, bus, shared);
  t.after(() => Promise.all([a.app.stop(), b.app.stop()]));
  await a.save(role("r1", unordered, 1));
  await a.save(role("r2", "editor", 0));
  assert.equal(await a.health(), "down");
  await a.app.stop();
  assert.equal(w.reads.list, 1);
  assert.equal(await b.health(), "up");
  assert.equal((await b.read("r1"))?.name, "admin");
  assert.equal(w.reads.byId, 0);
  await b.save(role("r3", "viewer", 0));
  assert.deepEqual(changesOn(b.bus), [[keyOf("r3", 1)]]);
  assert.deepEqual(await stored(store, "test:role:v1", "r3"), role("r3", "viewer", 1));
});

test(
  "a hydration that meets a missing order does not mark complete or publish ready",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup({
      roles: [role("r1", "admin"), role("r2", "editor"), withoutVersion(role("r3", "viewer")), role("r4", "guest")],
    });
    w.load.pages = 2;
    const a = await instance(w, store, bus, shared);
    t.after(() => a.app.stop());
    assert.equal(store.markers.get("test:role:v1")?.state, "loading");
    assert.deepEqual(a.bus.published.filter(isReady), []);
    assert.deepEqual(
      store.applies.map((changes) => changes.map((change) => change.id)),
      [["r1", "r2"]],
    );
    assert.equal(await a.health(), "down");
    assert.equal((await a.read("r1"))?.name, "admin");
    assert.equal(w.reads.byId, 1);
    await a.save(role("r5", "owner", 0));
    await a.app.stop();
    assert.equal(w.reads.list, 1);
    assert.deepEqual(changesOn(a.bus), []);
  },
);

test("a missing order met by a commit stops a hydration before its next page", { timeout: 10_000 }, async (t) => {
  const w = world({ database: new Map([["r1", role("r1", "admin")]]), startup: "background" });
  const store = memoryStore();
  const shared = memoryLock();
  const started = gate();
  const held = gate();
  w.load.started = started.open;
  w.load.gates.push(held.opened);
  const a = await instance(withUnordered(w), store, memoryBus(), shared);
  t.after(async () => {
    held.open();
    await a.app.stop();
  });
  await started.opened;
  const lease = shared.leases[0];
  assert.ok(lease);
  await a.save(role("r2", unordered, 0));
  held.open();
  await lease.finished;
  assert.equal(store.markers.get("test:role:v1")?.state, "loading");
  assert.deepEqual(store.applies, []);
  assert.deepEqual(a.bus.published.filter(isReady), []);
});

test(
  "a missing order met by a commit stops a hydration before its marker completes",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ database: new Map([["r1", role("r1", "admin")]]), startup: "background" });
    const store = memoryStore();
    const shared = memoryLock();
    const lastPage = store.holdNextApply();
    const a = await instance(withUnordered(w), store, memoryBus(), shared);
    t.after(async () => {
      lastPage.release();
      await a.app.stop();
    });
    await lastPage.reading;
    const lease = shared.leases[0];
    assert.ok(lease);
    await a.save(role("r2", unordered, 0));
    lastPage.release();
    await lease.finished;
    assert.equal(store.markers.get("test:role:v1")?.state, "loading");
    assert.deepEqual(a.bus.published.filter(isReady), []);
  },
);

test(
  "a change added during an in-flight publish survives when its own publish fails",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const traces = failureTraces();
    const a = await instance(w, store, bus, shared, [traces.provider]);
    t.after(() => a.app.stop());
    const inFlight = a.bus.holdNextPublish();
    await a.save(role("r1", "root", 1));
    await inFlight.reading;
    const failed = traces.next();
    a.bus.failNextPublish();
    await a.save(role("r2", "editor", 0));
    inFlight.release();
    await failed;
    await a.save(role("r3", "viewer", 0));
    await a.app.stop();
    assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)], [keyOf("r2", 1), keyOf("r3", 1)]]);
    assert.equal(w.reads.list, 1);
  },
);

test("a publish that throws synchronously causes no rebuild", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  t.after(() => a.app.stop());
  a.bus.throwNextPublish();
  const saved = await a.save(role("r1", "root", 1));
  assert.equal(saved.isError, false);
  assert.equal(await a.health(), "down");
  await a.save(role("r2", "editor", 0));
  assert.equal((await a.read("r1"))?.version, 2);
  await a.app.stop();
  assert.equal(w.reads.list, 1);
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2), keyOf("r2", 1)]]);
  assert.equal(store.markers.get("test:role:v1")?.dirty, false);
});

test(
  "a publish failure while adopting an older revision's change causes no rebuild",
  {
    timeout: 10_000,
  },
  async (t) => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const current = world({ database, revision: 2 });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const traces = failureTraces();
    const a = await instance(old, store, bus, shared);
    const b = await instance(current, store, bus, shared, [traces.provider]);
    t.after(() => Promise.all([a.app.stop(), b.app.stop()]));
    const failed = traces.next();
    b.bus.throwNextPublish();
    await a.save(role("r1", "root", 1));
    await failed;
    await b.save(role("r2", "editor", 0));
    await b.app.stop();
    assert.equal(current.reads.list, 1);
    assert.deepEqual(changesOn(b.bus, "test:role:v2"), [[keyOf("r1", 2), keyOf("r2", 1)]]);
    assert.equal(store.markers.get("test:role:v2")?.dirty, false);
  },
);

test(
  "an older revision's change without an order disables the adopting replication",
  {
    timeout: 10_000,
  },
  async (t) => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const current = world({ database, revision: 2 });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const traces = failureTraces();
    const a = await instance(old, store, bus, shared);
    const b = await instance(current, store, bus, shared, [traces.provider]);
    t.after(() => Promise.all([a.app.stop(), b.app.stop()]));
    const failed = traces.next();
    const calls = b.store.calls.length;
    database.set("r1", withoutVersion(role("r1", "root")));
    await a.bus.channel.publish({
      type: "changes",
      origin: "external",
      keyspace: "test:role:v1",
      changes: [keyOf("r1", 2)],
    });
    await failed;
    assert.equal(await b.health(), "down");
    await b.save(role("r2", "editor", 0));
    await b.app.stop();
    assert.deepEqual(b.store.calls.slice(calls), []);
    assert.equal(current.reads.list, 1);
    assert.deepEqual(changesOn(b.bus, "test:role:v2"), []);
    assert.deepEqual(await stored(store, "test:role:v2", "r1"), role("r1", "admin"));
  },
);

test("a read while not ready flushes the backlog without restoring the health", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  t.after(async () => {
    a.store.restore();
    await a.app.stop();
  });
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  a.store.lose();
  assert.equal((await a.read("r1"))?.version, 2);
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
  assert.equal(await healthAfterStop(w, a), "down");
});

test("a read during an in-flight publish starts no other publish", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const inFlight = a.bus.holdNextPublish();
  t.after(async () => {
    inFlight.release();
    await a.app.stop();
  });
  await a.save(role("r1", "root", 1));
  await inFlight.reading;
  // Absent from the instance layer, so the read reaches the shared layer's wrapper.
  assert.equal(await a.read("absent"), undefined);
  assert.equal(await a.read("absent"), undefined);
  assert.equal(changeAttempts(a.bus), 1);
  inFlight.release();
  await a.app.stop();
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
});

test("a disabled replication does not review or drop a newer revision", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(withUnordered(w), store, bus, shared);
  t.after(() => a.app.stop());
  await a.save(role("r1", unordered, 1));
  await markRevision(store, "test:role:v2", "loading");
  const calls = a.store.calls.length;
  const leases = shared.leases.length;
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
  await a.bus.channel.publish({ type: "changes", origin: "external", keyspace: "test:role:v0", changes: [] });
  assert.equal(a.store.calls.length, calls);
  await a.app.stop();
  assert.equal(a.store.calls.length, calls);
  assert.equal(shared.leases.length, leases);
  assert.equal(store.markers.get("test:role:v2")?.state, "loading");
});

test("a check in flight when the replication is disabled starts no review", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(withUnordered(w), store, bus, shared);
  const check = store.holdMarkerRead("test:role:v2", 1);
  t.after(async () => {
    check.release();
    await a.app.stop();
  });
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
  await markRevision(store, "test:role:v2", "loading");
  // The commit waits for its readiness check, which the held marker read keeps in flight.
  const checking = a.save(role("r2", "editor", 0));
  await check.reading;
  await a.save(role("r3", unordered, 0));
  const calls = a.store.calls.length;
  const leases = shared.leases.length;
  check.release();
  await checking;
  assert.deepEqual(a.store.calls.slice(calls), []);
  assert.equal(shared.leases.length, leases);
  assert.equal(store.markers.get("test:role:v2")?.state, "loading");
});

test("a disabled replication ignores rebuild() and restored connections", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(withUnordered(w), store, bus, shared, [w.roleReplication.rebuild]);
  t.after(() => a.app.stop());
  await a.save(role("r1", unordered, 1));
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v1" });
  const calls = a.store.calls.length;
  const attempts = a.bus.attempts.length;
  const rebuild = await a.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild));
  await rebuild();
  a.bus.lose();
  a.bus.restore();
  a.store.lose();
  a.store.restore();
  await a.app.stop();
  assert.deepEqual(a.store.calls.slice(calls), []);
  assert.equal(a.bus.attempts.length, attempts);
  assert.equal(w.reads.list, 1);
});

test("the channel's restored flushes the backlog", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  t.after(() => a.app.stop());
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  const reloaded = nextReload(w, await a.local());
  a.bus.lose();
  assert.deepEqual(changesOn(a.bus), []);
  a.bus.restore();
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
  await reloaded;
  assert.equal(w.reads.list, 1);
});

test("a readiness check flushes a backlog whose publish failed during the check", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  const inFlight = a.bus.holdNextPublish();
  const check = store.holdMarkerRead("test:role:v2", 1);
  t.after(async () => {
    inFlight.release();
    check.release();
    await a.app.stop();
  });
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await inFlight.reading;
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
  // The read's own flush finds the publish in flight; its readiness check is held past the failure.
  assert.equal((await a.read("r1"))?.version, 2);
  await check.reading;
  const failed = traces.next();
  inFlight.release();
  await failed;
  assert.deepEqual(changesOn(a.bus), []);
  const reloaded = nextReload(w, await a.local());
  check.release();
  await reloaded;
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
  assert.equal(w.reads.list, 1);
});

test("a successful flush restores the health while ready", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  t.after(() => a.app.stop());
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  assert.equal(await a.health(), "down");
  assert.equal(await a.read("absent"), undefined);
  assert.equal(await healthAfterStop(w, a), "up");
  assert.equal(w.reads.list, 1);
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
});

test("a second publish outage traces again after a successful flush", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  let inFlight: ReturnType<typeof a.bus.holdNextPublish> | undefined;
  t.after(async () => {
    inFlight?.release();
    await a.app.stop();
  });
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  inFlight = a.bus.holdNextPublish();
  assert.equal(await a.read("absent"), undefined);
  assert.equal(changeAttempts(a.bus), 2);
  await a.save(role("r2", "editor", 0));
  a.bus.failNextPublish();
  inFlight.release();
  await a.app.stop();
  assert.equal(traces.failures.length, 2);
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
});

test("the backlog merges a key's changes by entity and id", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  t.after(() => a.app.stop());
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 2));
  await a.save(role("r2", "editor", 0));
  await a.app.stop();
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 3), keyOf("r2", 1)]]);
});

test("the backlog keeps a key's newest change when an older one arrives later", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  t.after(() => a.app.stop());
  const superseded = store.dropped("test:role:v1", 1);
  await markRevision(store, "test:role:v2", "complete");
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v2" });
  await superseded;
  a.bus.failNextPublish();
  await a.save(role("r1", "newer", 5));
  a.bus.failNextPublish();
  await a.save(role("r1", "older", 1));
  await a.save(role("r2", "editor", 0));
  await a.app.stop();
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 6), keyOf("r2", 1)]]);
});

test("a commit during a publish that fails goes with the next attempt", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const inFlight = a.bus.holdNextPublish();
  t.after(async () => {
    inFlight.release();
    await a.app.stop();
  });
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await inFlight.reading;
  await a.save(role("r2", "editor", 0));
  inFlight.release();
  await a.app.stop();
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2), keyOf("r2", 1)]]);
  assert.equal(w.reads.list, 1);
});

test("a deletion of a key's own order replaces its pending set in the backlog", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const removeRole = writer<(value: Role) => Promise<Deleted<Role>>>();
  const removal = plug({
    port: removeRole,
    bind: () => async (value: Role) => {
      w.database.delete(value.id);
      return deleted(value);
    },
  });
  const remove = command<Role>()({
    requirements: { removeRole },
    run: async (value, ctx) => success(await ctx.removeRole(value)),
  });
  const a = await instance(w, store, bus, shared, [removal, remove]);
  t.after(() => a.app.stop());
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  a.bus.failNextPublish();
  await a.app.withScope((scope) => scope.resolve(remove)(role("r1", "root", 2)));
  await a.save(role("r2", "editor", 0));
  await a.app.stop();
  assert.deepEqual(changesOn(a.bus), [[{ ...keyOf("r1", 2), type: "delete" }, keyOf("r2", 1)]]);
});

test("a read after stop starts no publish", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  t.after(() => a.app.stop());
  const read = await a.app.withScope((scope) => scope.resolve(findRole));
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  await a.app.stop();
  const attempts = changeAttempts(a.bus);
  // Absent from the instance layer, so the read reaches the shared layer's wrapper.
  assert.equal(await read("absent"), undefined);
  assert.equal(changeAttempts(a.bus), attempts);
});

test("a commit in flight when the replication is disabled publishes nothing", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(withUnordered(w), store, bus, shared);
  const applying = store.holdNextApply();
  t.after(async () => {
    applying.release();
    await a.app.stop();
  });
  const saving = a.save(role("r1", "root", 1));
  await applying.reading;
  await a.save(role("r2", unordered, 0));
  const calls = a.store.calls.length;
  applying.release();
  await saving;
  await a.app.stop();
  assert.deepEqual(a.store.calls.slice(calls), []);
  assert.deepEqual(changesOn(a.bus), []);
});

test(
  "a publish in flight when the replication is disabled sends nothing after it",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(withUnordered(w), store, bus, shared);
    const inFlight = a.bus.holdNextPublish();
    t.after(async () => {
      inFlight.release();
      await a.app.stop();
    });
    await a.save(role("r1", "root", 1));
    await inFlight.reading;
    await a.save(role("r2", "editor", 0));
    await a.save(role("r3", unordered, 0));
    inFlight.release();
    await a.app.stop();
    assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
  },
);

test("a missing order is traced even after a publish failure", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(withUnordered(w), store, bus, shared, [traces.provider]);
  t.after(() => a.app.stop());
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  await a.save(role("r2", unordered, 0));
  assert.deepEqual(
    traces.failures.map((failure) => (failure as Error).name),
    ["Error", "TypeError"],
  );
});

test(
  "an adoption in flight when the replication is disabled does not report again",
  {
    timeout: 10_000,
  },
  async (t) => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const w = world({ database, revision: 2 });
    const traces = failureTraces();
    const b = await instance(withUnordered(w), memoryStore(), memoryBus(), memoryLock(), [traces.provider]);
    const reading = gate();
    const held = gate();
    t.after(async () => {
      held.open();
      await b.app.stop();
    });
    // The adoption reads the source through this map, and that read waits here.
    database.get = (id) => {
      reading.open();
      return held.opened.then(() => withoutVersion(role(id, "root"))) as unknown as Role;
    };
    await b.bus.channel.publish({
      type: "changes",
      origin: "external",
      keyspace: "test:role:v1",
      changes: [keyOf("r1", 2)],
    });
    await reading.opened;
    await b.save(role("r2", unordered, 0));
    held.open();
    await b.app.stop();
    assert.deepEqual(
      traces.failures.map((failure) => (failure as Error).name),
      ["TypeError"],
    );
  },
);

test(
  "a rebuild queued behind a hydration is dropped when the replication is disabled",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ database: new Map([["r1", role("r1", "admin")]]), startup: "background" });
    const started = gate();
    const held = gate();
    w.load.started = started.open;
    w.load.gates.push(held.opened);
    const a = await instance(withUnordered(w), memoryStore(), memoryBus(), memoryLock(), [w.roleReplication.rebuild]);
    t.after(async () => {
      held.open();
      await a.app.stop();
    });
    await started.opened;
    const rebuild = await a.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild));
    const rebuilt = rebuild();
    await a.save(role("r2", unordered, 0));
    held.open();
    await rebuilt;
    assert.equal(w.reads.list, 1);
  },
);

/** Resolves when the instance layer persists anything but a clear: a reload's states, even when it has none. */
function reloadPersisted(w: World, local: Map<string, Role>): Promise<void> {
  return new Promise((resolve) => {
    const watch = (map: Map<string, Role>, changes: readonly CacheChange[]) => {
      if (map !== local || changes.some((change) => change.type === "clear")) {
        return;
      }
      w.watchers.delete(watch);
      resolve();
    };
    w.watchers.add(watch);
  });
}

/**
 * The aborted attempt's lock release stays queued until the store is back, as a native offline queue answers it.
 * Until a new check ran, reads must reach the source, and that check must then rebuild the keyspace.
 */
async function restoreBeforeRelease(
  w: World,
  store: Store,
  bus: Bus,
  a: Running,
  release: { readonly reading: Promise<void>; release(): void },
  persisted: Promise<void>,
): Promise<void> {
  await release.reading;
  const recheck = store.holdMarkerRead("test:role:v2", 1);
  const ready = bus.next(isReady);
  try {
    a.store.restore();
    release.release();
    await Promise.race([recheck.reading, persisted]);
    assert.deepEqual(await a.read("r3"), role("r3", "viewer"));
    const reloaded = nextReload(w, await a.local());
    recheck.release();
    await ready;
    await reloaded;
  } finally {
    // A failed assertion must not leave stop waiting on this read.
    recheck.release();
  }
}

test(
  "a hydration aborted by a lost store is not ready when its lock release settles after restored",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ startup: "background" });
    for (const value of [role("r1", "admin"), role("r2", "editor"), role("r3", "viewer")]) {
      w.database.set(value.id, value);
    }
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const started = gate();
    const held = gate();
    w.load.started = started.open;
    w.load.gates.push(held.opened);
    const release = shared.holdNextRelease();
    const a = await instance(w, store, bus, shared);
    t.after(async () => {
      held.open();
      release.release();
      a.store.restore();
      await a.app.stop();
    });
    await started.opened;
    const persisted = reloadPersisted(w, await a.local());
    a.store.lose();
    held.open();
    await restoreBeforeRelease(w, store, bus, a, release, persisted);
    assert.deepEqual(
      {
        marker: store.markers.get("test:role:v1")?.state,
        stateCount: store.spaces.get("test:role:v1")?.size,
        read: await a.read("r3"),
        loads: w.reads.list,
        sourceReads: w.reads.byId,
        health: await a.health(),
      },
      { marker: "complete", stateCount: 3, read: role("r3", "viewer"), loads: 2, sourceReads: 1, health: "up" },
    );
  },
);

test(
  "a hydration aborted between pages by a lost store does not answer from the pages it wrote",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ startup: "background" });
    for (const value of [role("r1", "admin"), role("r2", "editor"), role("r3", "viewer"), role("r4", "guest")]) {
      w.database.set(value.id, value);
    }
    w.load.pages = 2;
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const firstPage = store.holdNextApply();
    const release = shared.holdNextRelease();
    const a = await instance(w, store, bus, shared);
    t.after(async () => {
      firstPage.release();
      release.release();
      a.store.restore();
      await a.app.stop();
    });
    await firstPage.reading;
    const persisted = reloadPersisted(w, await a.local());
    a.store.lose();
    firstPage.release();
    await restoreBeforeRelease(w, store, bus, a, release, persisted);
    assert.deepEqual(
      {
        marker: store.markers.get("test:role:v1")?.state,
        stateCount: store.spaces.get("test:role:v1")?.size,
        read: await a.read("r3"),
        loads: w.reads.list,
        sourceReads: w.reads.byId,
        health: await a.health(),
      },
      { marker: "complete", stateCount: 4, read: role("r3", "viewer"), loads: 2, sourceReads: 1, health: "up" },
    );
  },
);

/** An instance whose hydration has read one role from the source and waits on the returned gate. */
async function hydratingInstance(t: { after(fn: () => Promise<void>): void }) {
  const w = world({ startup: "background" });
  w.database.set("r1", role("r1", "admin"));
  const store = memoryStore();
  const bus = memoryBus();
  const started = gate();
  const held = gate();
  w.load.started = started.open;
  w.load.gates.push(held.opened);
  const a = await instance(w, store, bus, memoryLock());
  /** Released before the stop, so a failed test still exits. */
  const holds: { release(): void }[] = [];
  t.after(async () => {
    held.open();
    for (const hold of holds) {
      hold.release();
    }
    a.store.restore();
    await a.app.stop();
  });
  await started.opened;
  return { w, store, a, held, holds };
}

/** Reads back an instance that hydrated once more, because of the commit it could not apply. */
async function afterRebuild(w: World, store: Store, a: Running) {
  return {
    database: w.database.get("r1")?.version,
    read: (await a.read("r1"))?.version,
    secondRead: (await a.read("r1"))?.version,
    loads: w.reads.list,
    sourceReads: w.reads.byId,
    marker: store.markers.get("test:role:v1")?.state,
    dirty: store.markers.get("test:role:v1")?.dirty,
    health: await a.health(),
  };
}
const rebuiltOnce = {
  database: 2,
  read: 2,
  secondRead: 2,
  loads: 2,
  sourceReads: 0,
  marker: "complete",
  dirty: false,
  health: "up",
};

test(
  "a commit during an outage is rebuilt in when the own hydration survives the outage",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, a, held, holds } = await hydratingInstance(t);
    a.store.lose();
    await a.save(role("r1", "root", 1));
    const reloaded = nextReload(w, await a.local());
    const recheck = store.holdMarkerRead("test:role:v2", 1);
    holds.push(recheck);
    a.store.restore();
    held.open();
    await Promise.race([recheck.reading, reloaded]);
    // The attempt that may have missed the commit announces nothing.
    assert.equal(store.markers.get("test:role:v1")?.state, "loading");
    assert.deepEqual(a.bus.published.filter(isReady), []);
    recheck.release();
    await reloaded;
    assert.deepEqual(await afterRebuild(w, store, a), rebuiltOnce);
    assert.equal(a.bus.published.filter(isReady).length, 1);
  },
);

test(
  "a commit during an outage is rebuilt in when it arrives while the hydration completes",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, a, held, holds } = await hydratingInstance(t);
    const completing = store.holdNextMark();
    holds.push(completing);
    held.open();
    await completing.reading;
    a.store.lose();
    await a.save(role("r1", "root", 1));
    const reloaded = nextReload(w, await a.local());
    a.store.restore();
    completing.release();
    await reloaded;
    assert.deepEqual(await afterRebuild(w, store, a), rebuiltOnce);
    assert.equal(a.bus.published.filter(isReady).length, 1);
  },
);

test("a commit whose apply failed during the own hydration is rebuilt in", { timeout: 10_000 }, async (t) => {
  const { w, store, a, held } = await hydratingInstance(t);
  a.store.failNextApply();
  await a.save(role("r1", "root", 1));
  assert.equal(await a.health(), "down");
  const reloaded = nextReload(w, await a.local());
  held.open();
  await reloaded;
  assert.deepEqual(await afterRebuild(w, store, a), rebuiltOnce);
});

test(
  "health is down from a lost store or channel until the replication is ready again",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    t.after(async () => {
      a.store.restore();
      a.bus.restore();
      await a.app.stop();
    });
    const before = await a.health();
    a.store.lose();
    const storeLost = await a.health();
    const read = await a.read("r1");
    const storeLostAfterRead = await a.health();
    const storeCheck = store.holdNextMarker();
    const storeReload = nextReload(w, await a.local());
    a.store.restore();
    await storeCheck.reading;
    const storeRestoring = await a.health();
    storeCheck.release();
    await storeReload;
    const storeRestored = await a.health();
    a.bus.lose();
    const channelLost = await a.health();
    // The publish goes through the store's connection, so it succeeds without the subscription.
    await a.save(role("r2", "editor", 0));
    assert.deepEqual(changesOn(a.bus), [[keyOf("r2", 1)]]);
    const channelLostAfterPublish = await a.health();
    const channelCheck = store.holdNextMarker();
    const channelReload = nextReload(w, await a.local());
    a.bus.restore();
    await channelCheck.reading;
    const channelRestoring = await a.health();
    channelCheck.release();
    await channelReload;
    const channelRestored = await a.health();
    assert.deepEqual(
      {
        before,
        storeLost,
        storeLostAfterRead,
        read: read?.name,
        storeRestoring,
        storeRestored,
        channelLost,
        channelLostAfterPublish,
        channelRestoring,
        channelRestored,
      },
      {
        before: "up",
        storeLost: "down",
        storeLostAfterRead: "down",
        read: "admin",
        storeRestoring: "down",
        storeRestored: "up",
        channelLost: "down",
        channelLostAfterPublish: "down",
        channelRestoring: "down",
        channelRestored: "up",
      },
    );
  },
);

test("a read failure does not keep a superseded instance down", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  t.after(() => a.app.stop());
  // A miss in the instance layer reaches the real shared read wrapper.
  (await a.local()).clear();
  a.store.failNextGet();
  await a.read("r1");
  const failed = await a.health();
  const superseded = store.dropped("test:role:v1", 1);
  await markRevision(store, "test:role:v2", "complete");
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v2" });
  await superseded;
  const afterSuperseded = await a.health();
  a.store.lose();
  const lost = await a.health();
  a.store.restore();
  assert.deepEqual(
    { failed, superseded: afterSuperseded, lost, restored: await a.health() },
    { failed: "down", superseded: "up", lost: "down", restored: "up" },
  );
});

test(
  "a readiness check during a channel loss keeps the health down until the channel is back",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    t.after(() => a.app.stop());
    a.bus.lose();
    // The commit waits for its readiness check, which finds a current marker.
    await a.save(role("r1", "root", 1));
    const sourceReads = w.reads.byId;
    assert.equal((await a.read("r1"))?.version, 2);
    const sourced = w.reads.byId - sourceReads;
    const checked = await a.health();
    const channelReload = nextReload(w, await a.local());
    a.bus.restore();
    await channelReload;
    assert.deepEqual({ sourced, checked, restored: await a.health() }, { sourced: 1, checked: "down", restored: "up" });
  },
);

const adoptedChange = (order: number) => (message: ReplicationMessage) =>
  message.type === "changes" &&
  message.keyspace === "test:role:v2" &&
  message.changes.some((change) => change.order === order);

test(
  "a superseded instance's commit during an outage reaches the newer revision on restored",
  {
    timeout: 10_000,
  },
  async (t) => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const current = world({ database, revision: 2 });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const a = await instance(old, store, bus, shared);
    // Dropped by the v2 hydration and by the superseded instance, in either order.
    const superseded = store.dropped("test:role:v1", 2);
    const b = await instance(current, store, bus, shared);
    t.after(async () => {
      a.store.restore();
      await Promise.all([a.app.stop(), b.app.stop()]);
    });
    await superseded;
    a.store.lose();
    const calls = a.store.calls.length;
    await a.save(role("r1", "root", 1));
    assert.deepEqual(changesOn(a.bus), []);
    assert.equal(a.store.calls.length, calls);
    const adopted = bus.next(adoptedChange(2));
    a.store.restore();
    assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
    await adopted;
    assert.deepEqual(
      {
        database: database.get("r1")?.version,
        published: changesOn(a.bus).length,
        v2Read: (await b.read("r1"))?.version,
        v2Stored: await stored(store, "test:role:v2", "r1"),
        health: await a.health(),
      },
      { database: 2, published: 1, v2Read: 2, v2Stored: role("r1", "root", 2), health: "up" },
    );
  },
);

test(
  "a suspended instance's commit during an outage reaches the revision that completed meanwhile",
  {
    timeout: 10_000,
  },
  async (t) => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const current = world({ database, revision: 2 });
    const started = gate();
    const held = gate();
    current.load.started = started.open;
    current.load.held = held.opened;
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const a = await instance(old, store, bus, shared);
    const starting = instance(current, store, bus, shared);
    t.after(async () => {
      held.open();
      a.store.restore();
      await Promise.all([a.app.stop(), (await starting).app.stop()]);
    });
    await started.opened;
    a.store.lose();
    await a.save(role("r1", "root", 1));
    held.open();
    const b = await starting;
    assert.deepEqual(await stored(store, "test:role:v2", "r1"), role("r1", "admin"));
    const adopted = bus.next(adoptedChange(2));
    a.store.restore();
    assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
    await adopted;
    assert.deepEqual(
      {
        database: database.get("r1")?.version,
        v2Read: (await b.read("r1"))?.version,
        v2Stored: await stored(store, "test:role:v2", "r1"),
        loads: current.reads.list,
      },
      { database: 2, v2Read: 2, v2Stored: role("r1", "root", 2), loads: 1 },
    );
  },
);

test(
  "an older revision's change that arrives while the store is lost rebuilds on restored",
  {
    timeout: 10_000,
  },
  async (t) => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const old = world({ database });
    const current = world({ database, revision: 2 });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const a = await instance(old, store, bus, shared);
    const superseded = store.dropped("test:role:v1", 2);
    const b = await instance(current, store, bus, shared);
    t.after(async () => {
      b.store.restore();
      await Promise.all([a.app.stop(), b.app.stop()]);
    });
    await superseded;
    b.store.lose();
    await a.save(role("r1", "root", 1));
    const reloaded = nextReload(current, await b.local());
    b.store.restore();
    await reloaded;
    assert.deepEqual(
      {
        database: database.get("r1")?.version,
        published: changesOn(a.bus).length,
        v2Read: (await b.read("r1"))?.version,
        v2Stored: await stored(store, "test:role:v2", "r1"),
        loads: current.reads.list,
      },
      { database: 2, published: 1, v2Read: 2, v2Stored: role("r1", "root", 2), loads: 2 },
    );
  },
);

test("rebuild() while the store is lost rebuilds on restored", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
  t.after(async () => {
    a.store.restore();
    await a.app.stop();
  });
  const rebuild = await a.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild));
  a.store.lose();
  const calls = a.store.calls.length;
  await rebuild();
  assert.equal(a.store.calls.length, calls);
  const reloaded = nextReload(w, await a.local());
  a.store.restore();
  await reloaded;
  assert.deepEqual(
    { loads: w.reads.list, marker: store.markers.get("test:role:v1")?.state, health: await a.health() },
    { loads: 2, marker: "complete", health: "up" },
  );
});

/** An instance whose hydration has issued its first store call, which stays held until the returned release. */
async function heldHydration(t: { after(fn: () => Promise<void>): void }) {
  const w = world({ startup: "background" });
  w.database.set("r1", role("r1", "admin"));
  const store = memoryStore();
  const shared = memoryLock();
  const mark = store.holdNextMark();
  const a = await instance(w, store, memoryBus(), shared);
  /** Released before the stop, so a failed test still exits. */
  const holds: { release(): void }[] = [mark];
  t.after(async () => {
    for (const hold of holds) {
      hold.release();
    }
    a.store.restore();
    await a.app.stop();
  });
  await mark.reading;
  const lease = shared.leases[0];
  assert.ok(lease);
  return { w, store, a, mark, lease, holds };
}

/** After stop gave up on the held call, releasing it issues nothing new. */
async function assertNothingRunsAfterStop(held: Awaited<ReturnType<typeof heldHydration>>): Promise<void> {
  const { w, store, a, mark, lease } = held;
  const calls = a.store.calls.length;
  const attempts = a.bus.attempts.length;
  mark.release();
  await lease.finished;
  assert.deepEqual(
    {
      calls: a.store.calls.slice(calls),
      attempts: a.bus.attempts.slice(attempts),
      loads: w.reads.list,
      marker: store.markers.get("test:role:v1")?.state,
    },
    { calls: [], attempts: [], loads: 0, marker: "loading" },
  );
}

test("stop does not wait for a store call held behind a lost store", { timeout: 10_000 }, async (t) => {
  const held = await heldHydration(t);
  held.a.store.lose();
  await held.a.app.stop();
  await assertNothingRunsAfterStop(held);
});

test(
  "stop stops waiting for a held store call when the store is lost during the stop",
  {
    timeout: 10_000,
  },
  async (t) => {
    const held = await heldHydration(t);
    const stopping = held.a.app.stop();
    await held.a.bus.closed;
    held.a.store.lose();
    await stopping;
    await assertNothingRunsAfterStop(held);
  },
);

test("stop issues nothing after a hydration's held clear message", { timeout: 10_000 }, async (t) => {
  const held = await heldHydration(t);
  const publishing = held.a.bus.holdNextPublish();
  held.holds.push(publishing);
  held.mark.release();
  await publishing.reading;
  held.a.store.lose();
  await held.a.app.stop();
  const calls = held.a.store.calls.length;
  publishing.release();
  await held.lease.finished;
  assert.deepEqual(held.a.store.calls.slice(calls), []);
  assert.equal(held.w.reads.list, 0);
});

test("stop issues nothing after a hydration's held clear", { timeout: 10_000 }, async (t) => {
  const held = await heldHydration(t);
  const clearing = held.store.holdNextClear();
  held.holds.push(clearing);
  held.mark.release();
  await clearing.reading;
  held.a.store.lose();
  await held.a.app.stop();
  const calls = held.a.store.calls.length;
  clearing.release();
  await held.lease.finished;
  assert.deepEqual(held.a.store.calls.slice(calls), []);
  assert.equal(held.w.reads.list, 0);
});

test(
  "stop announces nothing after a hydration's held drop of the previous revision",
  {
    timeout: 10_000,
  },
  async (t) => {
    const w = world({ startup: "background", revision: 2 });
    w.database.set("r1", role("r1", "admin"));
    const store = memoryStore();
    const shared = memoryLock();
    const dropping = store.holdNextDrop();
    const a = await instance(w, store, memoryBus(), shared);
    t.after(async () => {
      dropping.release();
      a.store.restore();
      await a.app.stop();
    });
    await dropping.reading;
    const lease = shared.leases[0];
    assert.ok(lease);
    a.store.lose();
    await a.app.stop();
    dropping.release();
    await lease.finished;
    assert.deepEqual(a.bus.published.filter(isReady), []);
  },
);

test("stop drops no previous revision after a hydration's held complete mark", { timeout: 10_000 }, async (t) => {
  const w = world({ startup: "background", revision: 2 });
  w.database.set("r1", role("r1", "admin"));
  const store = memoryStore();
  const shared = memoryLock();
  const started = gate();
  const held = gate();
  w.load.started = started.open;
  w.load.gates.push(held.opened);
  const a = await instance(w, store, memoryBus(), shared);
  await started.opened;
  const completing = store.holdNextMark();
  t.after(async () => {
    completing.release();
    a.store.restore();
    await a.app.stop();
  });
  held.open();
  await completing.reading;
  const lease = shared.leases[0];
  assert.ok(lease);
  a.store.lose();
  await a.app.stop();
  const calls = a.store.calls.length;
  completing.release();
  await lease.finished;
  assert.deepEqual(a.store.calls.slice(calls), []);
});

test(
  "a commit whose store write is held when the store is lost settles and rebuilds on restored",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    const applying = store.holdNextApply();
    t.after(async () => {
      applying.release();
      a.store.restore();
      await a.app.stop();
    });
    const saving = a.save(role("r1", "root", 1));
    await applying.reading;
    a.store.lose();
    assert.equal((await saving).isError, false);
    assert.deepEqual(changesOn(a.bus), []);
    const reloaded = nextReload(w, await a.local());
    a.store.restore();
    applying.release();
    await reloaded;
    assert.deepEqual(
      { read: (await a.read("r1"))?.version, loads: w.reads.list, published: changesOn(a.bus) },
      { read: 2, loads: 2, published: [[keyOf("r1", 2)]] },
    );
  },
);

test("a commit waiting for a readiness check settles when the store is lost", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const check = store.holdMarkerRead("test:role:v2", 1);
  t.after(async () => {
    check.release();
    a.store.restore();
    await a.app.stop();
  });
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
  const saving = a.save(role("r1", "root", 1));
  await check.reading;
  a.store.lose();
  assert.equal((await saving).isError, false);
  assert.deepEqual(await stored(store, "test:role:v1", "r1"), role("r1", "root", 2));
});

test("a read held when the store is lost answers from the source", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const getting = a.store.holdNextGet();
  t.after(async () => {
    getting.release();
    a.store.restore();
    await a.app.stop();
  });
  // A miss in the instance layer reaches the shared read wrapper.
  (await a.local()).clear();
  const reading = a.read("r1");
  await getting.reading;
  w.database.set("r1", role("r1", "from the source", 2));
  a.store.lose();
  assert.equal((await reading)?.name, "from the source");
  assert.equal(w.reads.byId, 1);
});

test("a read overtaken by a peer's clear answers from the source", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const getting = a.store.holdNextGet();
  t.after(async () => {
    getting.release();
    await a.app.stop();
  });
  (await a.local()).clear();
  const reading = a.read("absent");
  await getting.reading;
  w.database.set("absent", role("absent", "created", 2));
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
  getting.release();
  assert.equal((await reading)?.name, "created");
});

/** A v1 instance with an abandoned v2 rollout to review; `finished` opens when the review's lock has been released. */
async function reviewingRollout(t: { after(fn: () => Promise<void>): void }, beforeLock: (a: Running) => void) {
  const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
  const store = memoryStore();
  const shared = memoryLock();
  const finished = gate();
  const running: { a?: Running } = {};
  const reviewing: Lock = {
    async tryRun(name, options, work) {
      if (name !== "test:role:v2:hydration" || running.a === undefined) {
        return shared.tryRun(name, options, work);
      }
      beforeLock(running.a);
      try {
        return await shared.tryRun(name, options, work);
      } finally {
        finished.open();
      }
    },
  };
  const a = await instance(old, store, memoryBus(), reviewing);
  running.a = a;
  /** Released before the stop, so a failed test still exits. */
  const holds: { release(): void }[] = [];
  t.after(async () => {
    for (const hold of holds) {
      hold.release();
    }
    a.store.restore();
    await a.app.stop();
  });
  await markRevision(store, "test:role:v2", "loading");
  return { store, a, finished, holds };
}

test("a store lost while a review takes the lock keeps the rollout", { timeout: 10_000 }, async (t) => {
  const { store, a, finished } = await reviewingRollout(t, (running) => running.store.lose());
  const calls = a.store.calls.length;
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
  await finished.opened;
  // Only the review's read before the lock.
  assert.deepEqual(a.store.calls.slice(calls), ["marker"]);
  assert.equal(store.markers.get("test:role:v2")?.state, "loading");
});

test("a store lost during a review's read inside the lock keeps the rollout", { timeout: 10_000 }, async (t) => {
  const { store, a, finished, holds } = await reviewingRollout(t, () => undefined);
  const insideLock = store.holdMarkerRead("test:role:v2", 2);
  holds.push(insideLock);
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v2" });
  await insideLock.reading;
  a.store.lose();
  insideLock.release();
  await finished.opened;
  assert.equal(store.markers.get("test:role:v2")?.state, "loading");
  assert.equal(a.store.calls.includes("drop"), false);
});

test(
  "a rebuild interrupted by a lost store while it takes the lock rebuilds on restored",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    let losing: (() => void) | undefined;
    const a = await instance(
      w,
      store,
      bus,
      lockWith(shared, () => losing?.()),
      [w.roleReplication.rebuild],
    );
    t.after(async () => {
      a.store.restore();
      await a.app.stop();
    });
    const rebuild = await a.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild));
    let calls = 0;
    losing = () => {
      losing = undefined;
      a.store.lose();
      calls = a.store.calls.length;
    };
    await rebuild();
    assert.deepEqual(a.store.calls.slice(calls), []);
    const reloaded = nextReload(w, await a.local());
    a.store.restore();
    await reloaded;
    assert.equal(w.reads.list, 2);
  },
);

test("stop does not wait for a publish held behind a lost store", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  const flushing = a.bus.holdNextPublish();
  t.after(async () => {
    flushing.release();
    a.store.restore();
    await a.app.stop();
  });
  a.store.lose();
  assert.equal((await a.read("r1"))?.version, 2);
  await flushing.reading;
  await a.app.stop();
  assert.deepEqual(changesOn(a.bus), []);
});

test("an adoption in flight at stop writes nothing", { timeout: 10_000 }, async (t) => {
  const database = new Map([["r1", role("r1", "admin")]]);
  const w = world({ database, revision: 2 });
  const b = await instance(w, memoryStore(), memoryBus(), memoryLock());
  const reading = gate();
  const held = gate();
  t.after(async () => {
    held.open();
    await b.app.stop();
  });
  // The adoption reads the source through this map, and that read waits here.
  database.get = (id) => {
    reading.open();
    return held.opened.then(() => role(id, "root", 2)) as unknown as Role;
  };
  await b.bus.channel.publish({
    type: "changes",
    origin: "external",
    keyspace: "test:role:v1",
    changes: [keyOf("r1", 2)],
  });
  await reading.opened;
  const calls = b.store.calls.length;
  const stopped = b.app.stop();
  await b.bus.closed;
  held.open();
  await stopped;
  assert.deepEqual(b.store.calls.slice(calls), []);
});

test(
  "an adoption whose source read outlasts the store writes nothing to the lost store",
  { timeout: 10_000 },
  async (t) => {
    const database = new Map([["r1", role("r1", "admin")]]);
    const w = world({ database, revision: 2 });
    const b = await instance(w, memoryStore(), memoryBus(), memoryLock());
    const reading = gate();
    const held = gate();
    t.after(async () => {
      held.open();
      b.store.restore();
      await b.app.stop();
    });
    database.get = (id) => {
      reading.open();
      return held.opened.then(() => role(id, "root", 2)) as unknown as Role;
    };
    const calls = b.store.calls.length;
    await b.bus.channel.publish({
      type: "changes",
      origin: "external",
      keyspace: "test:role:v1",
      changes: [keyOf("r1", 2)],
    });
    await reading.opened;
    b.store.lose();
    held.open();
    // The adoption settles in promise reactions, which all run before the next event-loop turn.
    await nextTurn();
    assert.equal(b.store.calls.slice(calls).includes("apply"), false);
  },
);

test(
  "a superseded replication disabled during a publish stays unhealthy after it succeeds",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(withUnordered(w), store, bus, shared);
    let inFlight: ReturnType<typeof a.bus.holdNextPublish> | undefined;
    t.after(async () => {
      inFlight?.release();
      await a.app.stop();
    });
    const superseded = store.dropped("test:role:v1", 1);
    await markRevision(store, "test:role:v2", "complete");
    await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v2" });
    await superseded;
    inFlight = a.bus.holdNextPublish();
    await a.save(role("r1", "root", 1));
    await inFlight.reading;
    await a.save(role("r2", unordered, 0));
    assert.equal(await a.health(), "down");
    inFlight.release();
    const health = await healthAfterStop(w, a);
    assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
    assert.equal(health, "down", "a successful publish must not restore a disabled replication's health");
  },
);

import { failure } from "@openknot-ts/behavior";
import { defaultUnitOfWork } from "@openknot-ts/flow";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";

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

for (const trigger of ["a read", "a rebuild", "an older revision's message"] as const) {
  test(
    `background work started by ${trigger} inside a Unit of Work stores no uncommitted row`,
    {
      timeout: 10_000,
    },
    async () => {
      const adopting = trigger === "an older revision's message";
      const keyspace = adopting ? "test:role:v2" : "test:role:v1";
      const database = sessionDatabase([role("r1", "admin")]);
      const ambient = new AsyncLocalStorage<string>();
      const sourcedIn = new Set<string | undefined>();
      let loadFailures = trigger === "a read" ? 1 : 0;
      const roleReaders = plug({
        port: reader.compose({ byId: findRole, list: listRoles }),
        bind: () => ({
          byId: async (id: string) => {
            if (id === "phantom") {
              sourcedIn.add(ambient.getStore());
            }
            return database.current.get(id);
          },
          list: async () => {
            sourcedIn.add(ambient.getStore());
            if (loadFailures-- > 0) {
              throw new Error("source unavailable");
            }
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
      const roleReplication = replication({
        roleReaders,
        rolesShared: replication.distributed({
          entity: "role",
          port: reader.compose({ byId: findRole }),
          namespace: "test:role",
          load: listRoles,
          startup: "blocking",
          ...(adopting ? { revision: 2 } : {}),
        }),
      });
      const store = memoryStore();
      const bus = memoryBus();
      const older = bus.connect();
      const vetoed = command({
        requirements: { saveRole, findRole, rebuild: roleReplication.rebuild },
        run: async (_, ctx) => {
          await ctx.saveRole(role("phantom", "ghost", 0));
          if (trigger === "a read") {
            const ready = bus.next(isReady);
            await ctx.findRole("r1");
            await ready;
          } else if (trigger === "a rebuild") {
            await ctx.rebuild();
          } else {
            const adopted = bus.next((message) => message.type === "changes" && message.keyspace === keyspace);
            await older.channel.publish({
              type: "changes",
              origin: "older",
              keyspace: "test:role:v1",
              changes: [{ entity: "role", id: "phantom", order: 1, type: "set" }],
            });
            await adopted;
          }
          return failure(new Error("veto"));
        },
      });
      const providers: readonly object[] = [
        ...Object.values(roleReplication),
        saves,
        vetoed,
        plug({ port: defaultUnitOfWork, bind: () => database }),
        unit({ provides: replicaStore, factory: () => store.connect().store }),
        unit({ provides: replicationChannel, factory: () => bus.connect().channel }),
        unit({ provides: lock, factory: () => memoryLock() }),
      ];
      const app = await ambient.run("startup", () =>
        runApplication(
          defineApplication({ modules: [composeModule({ providers: providers.map((source) => ({ source })) })] }),
        ),
      );
      try {
        const outcome = await ambient.run("request", () => app.withScope((scope) => scope.resolve(vetoed)()));
        assert.equal(outcome.isError, true);
        assert.equal(database.current.has("phantom"), false);
        const shared = store.connect().store;
        assert.equal(await shared.get(keyspace, "role", "phantom"), undefined);
        assert.equal(((await shared.get(keyspace, "role", "r1")) as Role | undefined)?.name, "admin");
        assert.deepEqual([...sourcedIn], ["startup"]);
      } finally {
        await app.stop();
      }
    },
  );
}

function contextTraces() {
  const ambient = new AsyncLocalStorage<string>();
  const spans: { readonly name: string; readonly parent: string | undefined }[] = [];
  const failed = Promise.withResolvers<void>();
  const tracing: Tracing = {
    async run(span, work) {
      const parent = ambient.getStore();
      try {
        return await ambient.run(span.name, work);
      } finally {
        spans.push({ name: span.name, parent });
        if (span.name === "test:role replication failed") {
          failed.resolve();
        }
      }
    },
    capture: () => undefined,
    bind(work) {
      const captured = AsyncLocalStorage.snapshot();
      return () => captured(work);
    },
  };
  return { ambient, spans, failed: failed.promise, provider: unit({ provides: trace, factory: () => tracing }) };
}

for (const trigger of ["rebuild", "recheck", "adoption"] as const) {
  test(`a ${trigger} rejection reports outside the requesting trace`, { timeout: 10_000 }, async (t) => {
    const traces = contextTraces();
    const w = world({ revision: trigger === "adoption" ? 2 : 1 });
    w.database.set("r1", role("r1", "admin"));
    const a = await instance(w, memoryStore(), memoryBus(), memoryLock(), [w.roleReplication.rebuild, traces.provider]);
    try {
      if (trigger === "rebuild") {
        w.load.failures = 1;
      }
      if (trigger === "recheck") {
        await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
        a.store.store.runId = async () => {
          throw new Error("marker check failed");
        };
      }
      if (trigger === "adoption") {
        a.store.failNextApply();
      }
      await traces.ambient.run("request", async () => {
        if (trigger === "rebuild") {
          await (
            await a.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild))
          )();
        } else if (trigger === "recheck") {
          assert.equal((await a.read("r1"))?.name, "admin");
        } else {
          await a.bus.channel.publish({
            type: "changes",
            origin: "older",
            keyspace: "test:role:v1",
            changes: [keyOf("r1", 1)],
          });
        }
        await traces.failed;
      });
      const failed = traces.spans.filter((span) => span.name === "test:role replication failed");
      t.diagnostic(JSON.stringify({ trigger, failureParents: failed.map((span) => span.parent ?? null) }));
      assert.deepEqual(
        failed.map((span) => span.parent),
        [undefined],
      );
    } finally {
      await a.app.stop();
    }
  });
}

for (const finish of ["marker reply", "lost"] as const) {
  test(`commit readiness uses startup context and ends its wait at ${finish}`, { timeout: 10_000 }, async (t) => {
    const ambient = new AsyncLocalStorage<string>();
    const { w, store, bus, shared } = setup();
    const a = await ambient.run("startup", () => instance(w, store, bus, shared));
    const contexts: (string | undefined)[] = [];
    const listing = Promise.withResolvers<void>();
    const listed = Promise.withResolvers<void>();
    const nativeList = a.store.store.list;
    const nativeRunId = a.store.store.runId;
    a.store.store.runId = () => {
      contexts.push(ambient.getStore());
      return nativeRunId();
    };
    a.store.store.list = async (...args) => {
      contexts.push(ambient.getStore());
      listing.resolve();
      await listed.promise;
      return nativeList(...args);
    };
    w.watchers.add((_local, changes) => {
      if (changes.some((change) => change.type === "set")) {
        contexts.push(ambient.getStore());
      }
    });
    const marker = store.holdNextMarker();
    try {
      await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
      const reloaded = nextReload(w, await a.local());
      let completed = false;
      const saving = ambient
        .run("request", () => a.save(role("r1", "new")))
        .then((value) => {
          completed = true;
          return value;
        });
      await marker.reading;
      assert.equal(completed, false, "the command must still wait for the marker check");
      if (finish === "lost") {
        a.store.lose();
      } else {
        marker.release();
      }
      assert.equal((await saving).isError, false);
      if (finish === "marker reply") {
        await listing.promise;
        listed.resolve();
        await reloaded;
        assert.equal((await a.local()).get("r1")?.name, "new");
      }
      t.diagnostic(JSON.stringify({ finish, contexts, completed }));
      assert.deepEqual(contexts, finish === "lost" ? ["startup"] : ["startup", "startup", "startup"]);
    } finally {
      marker.release();
      listed.resolve();
      await a.app.stop();
    }
  });
}

for (const trigger of ["commit", "channel"] as const) {
  test(`an instance refresh from a ${trigger} keeps startup context`, { timeout: 10_000 }, async (t) => {
    const ambient = new AsyncLocalStorage<string>();
    const { w, store, bus, shared } = setup();
    const a = await ambient.run("startup", () => instance(w, store, bus, shared));
    const contexts: (string | undefined)[] = [];
    w.watchers.add((_local, changes) => {
      if (changes.some((change) => change.type === "set")) {
        contexts.push(ambient.getStore());
      }
    });
    try {
      const refreshed = nextReload(w, await a.local());
      await ambient.run("request", async () => {
        if (trigger === "commit") {
          assert.equal((await a.save(role("r1", "new"))).isError, false);
        } else {
          await a.store.store.apply("test:role:v1", [{ ...keyOf("r1", 2), value: role("r1", "new", 2) }]);
          await a.bus.channel.publish({
            type: "changes",
            origin: "external",
            keyspace: "test:role:v1",
            changes: [keyOf("r1", 2)],
          });
        }
        await refreshed;
      });
      t.diagnostic(JSON.stringify({ trigger, refreshContexts: contexts }));
      assert.deepEqual(contexts, ["startup"]);
      assert.equal((await a.local()).get("r1")?.name, "new");
    } finally {
      await a.app.stop();
    }
  });
}

test(
  "a read failure keeps its caller trace while instance cleanup uses startup context",
  {
    timeout: 10_000,
  },
  async (t) => {
    const traces = contextTraces();
    const { w, store, bus, shared } = setup();
    const a = await traces.ambient.run("startup", () => instance(w, store, bus, shared, [traces.provider]));
    const clears: (string | undefined)[] = [];
    w.watchers.add((_local, changes) => {
      if (changes.some((change) => change.type === "clear")) {
        clears.push(traces.ambient.getStore());
      }
    });
    try {
      (await a.local()).clear();
      a.store.failNextGet();
      assert.equal((await traces.ambient.run("request", () => a.read("r1")))?.name, "admin");
      await traces.failed;
      const parents = traces.spans
        .filter((span) => span.name === "test:role replication failed")
        .map((span) => span.parent);
      t.diagnostic(JSON.stringify({ parents, clearContexts: clears }));
      assert.deepEqual(parents, ["request"]);
      assert.deepEqual(clears, ["startup"]);
    } finally {
      await a.app.stop();
    }
  },
);

test("a replica retains the context captured at application startup", { timeout: 10_000 }, async () => {
  const ambient = new AsyncLocalStorage<string>();
  const w = world({ include: () => ambient.getStore() === "startup" });
  w.database.set("r1", role("r1", "admin"));
  const a = await ambient.run("startup", () =>
    instance(w, memoryStore(), memoryBus(), memoryLock(), [w.roleReplication.rebuild]),
  );
  try {
    await ambient.run("request", async () =>
      (await a.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild)))(),
    );
    assert.equal((await a.local()).get("r1")?.name, "admin");
  } finally {
    await a.app.stop();
  }
});

test(
  "stop after store restoration does not wait for a commit marker released by loss",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
    const marker = store.holdNextMarker();
    t.signal.addEventListener("abort", () => marker.release(), { once: true });
    try {
      await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
      const saving = a.save(role("r1", "new"));
      await marker.reading;
      a.store.lose();
      assert.equal((await saving).isError, false);
      const reloaded = nextReload(w, await a.local());
      a.store.restore();
      await reloaded;
      assert.equal((await a.read("r1"))?.name, "new");
      assert.equal((await a.local()).get("r1")?.name, "new");
      t.diagnostic("restored store and instance both read new while the original marker is held");
      const stopping = a.app.stop();
      await a.bus.closed;
      await stopping;
      t.diagnostic("stop ended without the original marker reply");
    } finally {
      marker.release();
      await a.app.stop();
    }
  },
);

const hydrationLock = "test:role:v1:hydration";
const rebuilder = (w: World, each: Running) => each.app.withScope((scope) => scope.resolve(w.roleReplication.rebuild));

/** A peer's hydration under way: it holds the lock, marked the keyspace loading and cleared it. The call finishes it. */
async function peerLoading(store: Store, shared: Lock): Promise<() => Promise<void>> {
  const finished = gate();
  const loading = gate();
  const connection = store.connect().store;
  const runId = await connection.runId();
  const holding = shared.tryRun(hydrationLock, { leaseMs: 60_000 }, async ({ token }) => {
    await connection.mark("test:role:v1", { state: "loading", dirty: false, runId, holder: token });
    await connection.clear("test:role:v1", token);
    loading.open();
    await finished.opened;
    await connection.apply("test:role:v1", [{ ...keyOf("r1", 1), value: role("r1", "admin") }], token);
    await connection.mark("test:role:v1", { state: "complete", dirty: false, runId, holder: token }, token);
  });
  await loading.opened;
  return async () => {
    finished.open();
    await holding;
  };
}

/** Holds the next marker read of the keyspace after it read its value, as a slow store answers late. */
function staleMarkerReply(a: Running) {
  const native = a.store.store.marker;
  const reached = gate();
  const released = gate();
  const reread = gate();
  let held = false;
  let replying = false;
  a.store.store.marker = async (keyspace) => {
    const value = await native(keyspace);
    if (keyspace !== "test:role:v1") {
      return value;
    }
    if (!held) {
      held = true;
      reached.open();
      await released.opened;
    } else if (replying) {
      reread.open();
    }
    return value;
  };
  return {
    reached: reached.opened,
    /** Opens when a marker read started after the release. */
    reread: reread.opened,
    release() {
      replying = true;
      released.open();
    },
  };
}

for (const interruption of ["a peer's clear", "a store outage", "a channel restoration", "its own rebuild"] as const) {
  test(`a marker reply older than ${interruption} does not make the instance ready`, { timeout: 10_000 }, async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
    const load = gate();
    const started = gate();
    const finishes: (() => Promise<void>)[] = [];
    let rebuilt: Promise<void> | undefined;
    const stale = staleMarkerReply(a);
    t.after(async () => {
      stale.release();
      load.open();
      await rebuilt;
      await Promise.all(finishes.map((finish) => finish()));
      a.store.restore();
      await a.app.stop();
    });
    if (interruption === "a channel restoration") {
      a.bus.lose();
    }
    await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
    const persisted = reloadPersisted(w, await a.local());
    await a.read("r1");
    await stale.reached;
    if (interruption === "its own rebuild") {
      w.load.gates.push(load.opened);
      w.load.started = started.open;
      rebuilt = (await rebuilder(w, a))();
      await started.opened;
    } else if (interruption === "a store outage") {
      a.store.lose();
      finishes.push(await peerLoading(store, shared));
      a.store.restore();
    } else {
      finishes.push(await peerLoading(store, shared));
      if (interruption === "a channel restoration") {
        a.bus.restore();
      } else {
        await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
      }
    }
    stale.release();
    await Promise.race([stale.reread, persisted]);
    assert.equal(store.markers.get("test:role:v1")?.state, "loading");
    assert.equal((await a.read("r1"))?.name, "admin");
  });
}

test("a ready message during a marker read is not lost to that read's older reply", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const finish = await peerLoading(store, shared);
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
  const stale = staleMarkerReply(a);
  t.after(async () => {
    stale.release();
    await a.app.stop();
  });
  await a.read("r1");
  await stale.reached;
  await finish();
  const reloaded = nextReload(w, await a.local());
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v1" });
  stale.release();
  await reloaded;
  const sourceReads = w.reads.byId;
  assert.equal((await a.read("r1"))?.name, "admin");
  assert.deepEqual({ loads: w.reads.list, sourceReads: w.reads.byId }, { loads: 1, sourceReads });
});

test("a ready message during an attempt that loses the lock is checked after it", { timeout: 10_000 }, async (t) => {
  const w = world({ startup: "background" });
  w.database.set("r1", role("r1", "admin"));
  const store = memoryStore();
  const bus = memoryBus();
  const shared = memoryLock();
  const finish = await peerLoading(store, shared);
  const contended = gate();
  const proceed = gate();
  const a = await instance(
    w,
    store,
    bus,
    lockWith(shared, async () => {
      contended.open();
      await proceed.opened;
    }),
  );
  t.after(async () => {
    proceed.open();
    await finish();
    await a.app.stop();
  });
  await contended.opened;
  // The peer holds its lock while it announces, so this attempt loses it.
  const connection = store.connect().store;
  await connection.apply("test:role:v1", [{ ...keyOf("r1", 1), value: role("r1", "admin") }]);
  await connection.mark("test:role:v1", { state: "complete", dirty: false, runId: await connection.runId() });
  const reloaded = nextReload(w, await a.local());
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v1" });
  proceed.open();
  await reloaded;
  assert.equal((await a.read("r1"))?.name, "admin");
  assert.deepEqual({ loads: w.reads.list, sourceReads: w.reads.byId }, { loads: 0, sourceReads: 0 });
});

test(
  "a holder whose lease expired announces ready without effect during its successor's load",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
    const b = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
    const c = await instance(w, store, bus, shared);
    const aLoad = gate();
    const aStarted = gate();
    const bLoad = gate();
    const bStarted = gate();
    w.load.gates.push(aLoad.opened, bLoad.opened);
    w.load.started = aStarted.open;
    const aRebuilt = (await rebuilder(w, a))();
    let lateReady: ReturnType<typeof a.bus.holdNextPublish> | undefined;
    t.after(async () => {
      aLoad.open();
      bLoad.open();
      lateReady?.release();
      await Promise.all([a.app.stop(), b.app.stop(), c.app.stop()]);
    });
    await aStarted.opened;
    lateReady = a.bus.holdNextPublish();
    aLoad.open();
    await lateReady.reading;
    assert.equal(store.markers.get("test:role:v1")?.state, "complete");
    shared.expire(hydrationLock);
    w.load.started = bStarted.open;
    const bRebuilt = (await rebuilder(w, b))();
    await bStarted.opened;
    const delivered = bus.next(isReady);
    lateReady.release();
    await delivered;
    await aRebuilt;
    const late = {
      marker: store.markers.get("test:role:v1")?.state,
      holder: (await a.read("r1"))?.name,
      receiver: (await c.read("r1"))?.name,
      holderLocal: (await a.local()).size,
    };
    assert.deepEqual(late, { marker: "loading", holder: "admin", receiver: "admin", holderLocal: 0 });
    const reloads = [nextReload(w, await a.local()), nextReload(w, await c.local())];
    bLoad.open();
    await bRebuilt;
    await Promise.all(reloads);
    const sourceReads = w.reads.byId;
    assert.deepEqual([(await a.read("r1"))?.name, (await c.read("r1"))?.name], ["admin", "admin"]);
    assert.equal(w.reads.byId, sourceReads);
  },
);

test(
  "during a channel loss a peer's rebuild does not make the shared layer answer absence",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    const b = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
    const load = gate();
    const started = gate();
    let rebuilt: Promise<void> | undefined;
    t.after(async () => {
      load.open();
      await rebuilt;
      await Promise.all([a.app.stop(), b.app.stop()]);
    });
    a.bus.lose();
    a.bus.drop("clear");
    a.bus.drop("ready");
    w.load.gates.push(load.opened);
    w.load.started = started.open;
    rebuilt = (await rebuilder(w, b))();
    await started.opened;
    assert.equal(store.markers.get("test:role:v1")?.state, "loading");
    assert.equal((await a.read("r1"))?.name, "admin");
  },
);

/** Makes the instance store fail the next persist of a change of the type. */
function failNextPersist(w: World, type: CacheChange["type"]): void {
  const thrower = (_local: Map<string, Role>, changes: readonly CacheChange[]) => {
    if (!changes.some((change) => change.type === type)) {
      return;
    }
    w.watchers.delete(thrower);
    throw new Error("instance store failed");
  };
  w.watchers.add(thrower);
}

/** Resolves when the instance layer persists every role of the two-role fixture at once, as only a reload does. */
function fullReload(w: World, local: Map<string, Role>): Promise<void> {
  return new Promise((resolve) => {
    const watch = (map: Map<string, Role>, changes: readonly CacheChange[]) => {
      if (map !== local || changes.filter((change) => change.type === "set").length < 2) {
        return;
      }
      w.watchers.delete(watch);
      resolve();
    };
    w.watchers.add(watch);
  });
}

const twoRoles = [role("r1", "admin"), role("r2", "editor")];

for (const failure of ["reload", "refresh"] as const) {
  for (const retry of ["read", "commit"] as const) {
    test(`a failed instance ${failure} recovers on the next ${retry}`, { timeout: 10_000 }, async (t) => {
      const { w, store, bus, shared } = setup({ roles: twoRoles });
      const traces = failureTraces();
      const a = await instance(w, store, bus, shared, [traces.provider]);
      t.after(() => a.app.stop());
      const local = await a.local();
      const failed = traces.next();
      if (failure === "reload") {
        await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
        failNextPersist(w, "clear");
        await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v1" });
      } else {
        failNextPersist(w, "set");
        await a.save(role("r1", "root", 1));
      }
      await failed;
      const afterFailure = await a.health();
      const reloaded = fullReload(w, local);
      if (retry === "read") {
        await a.read("r1");
      } else {
        await a.save(role("r2", "viewer", 1));
      }
      await reloaded;
      // Absent from the instance layer, so the read reaches the shared layer's wrapper, which has nothing left to retry.
      const calls = a.store.calls.length;
      assert.equal(await a.read("absent"), undefined);
      assert.deepEqual(
        {
          afterFailure,
          recovered: await a.health(),
          keys: [...local.keys()].sort(),
          loads: w.reads.list,
          retried: a.store.calls.slice(calls).includes("runId"),
        },
        { afterFailure: "down", recovered: "up", keys: ["r1", "r2"], loads: 1, retried: false },
      );
    });
  }
}

test("a successful publish does not report up while the instance layer is off", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup({ roles: twoRoles });
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  let inFlight: ReturnType<typeof a.bus.holdNextPublish> | undefined;
  t.after(async () => {
    inFlight?.release();
    await a.app.stop();
  });
  const failed = traces.next();
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
  const retried = gate();
  let reloads = 0;
  w.watchers.add((_local, changes) => {
    if (changes.some((change) => change.type === "clear") && ++reloads === 2) {
      retried.open();
    }
    throw new Error("instance store failed");
  });
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v1" });
  await failed;
  // Its retry fails again while the publish is held, so the publish succeeds after the failure.
  inFlight = a.bus.holdNextPublish();
  await a.save(role("r1", "root", 1));
  await retried.opened;
  inFlight.release();
  assert.equal(await healthAfterStop(w, a), "down");
  assert.deepEqual(changesOn(a.bus), [[keyOf("r1", 2)]]);
});

test("a successful publish restores a superseded instance's health", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const traces = failureTraces();
  const a = await instance(w, store, bus, shared, [traces.provider]);
  t.after(() => a.app.stop());
  const superseded = store.dropped("test:role:v1", 1);
  await markRevision(store, "test:role:v2", "complete");
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v2" });
  await superseded;
  const failed = traces.next();
  a.bus.failNextPublish();
  await a.save(role("r1", "root", 1));
  await failed;
  assert.equal(await a.health(), "down");
  await a.save(role("r2", "editor", 0));
  assert.equal(await healthAfterStop(w, a), "up");
});

for (const trigger of ["instance read", "shared read", "commit"] as const) {
  test(
    `a rebuild that found a crashed holder's lock runs on the next ${trigger} without making it wait`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const { w, store, bus, shared } = setup();
      const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
      const load = gate();
      const started = gate();
      t.after(async () => {
        load.open();
        await a.app.stop();
      });
      const crashed = gate();
      const holding = shared.tryRun(hydrationLock, { leaseMs: 1 }, () => crashed.opened);
      await (
        await rebuilder(w, a)
      )();
      crashed.open();
      await holding;
      assert.equal(w.reads.list, 1);
      w.load.started = started.open;
      w.load.gates.push(load.opened);
      // The load gate stays closed until the trigger has settled.
      if (trigger === "instance read") {
        assert.equal((await a.read("r1"))?.name, "admin");
      } else if (trigger === "shared read") {
        assert.equal(await a.read("absent"), undefined);
      } else {
        assert.equal((await a.save(role("r1", "root", 1))).isError, false);
      }
      await started.opened;
      const ready = bus.next(isReady);
      load.open();
      await ready;
      assert.equal(w.reads.list, 2);
      assert.equal(store.markers.get("test:role:v1")?.dirty, false);
    },
  );
}

test(
  "reads while a rebuild is pending share one check, and a clean found-value read makes none",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
    const crashed = gate();
    const holding = shared.tryRun(hydrationLock, { leaseMs: 60_000 }, () => crashed.opened);
    const check = store.holdNextMarker();
    t.after(async () => {
      check.release();
      crashed.open();
      await holding;
      await a.app.stop();
    });
    const clean = a.store.calls.length;
    // A found value needs no completeness confirmation. Misses and lists own that cost in the test below.
    (await a.local()).clear();
    assert.equal((await a.read("r1"))?.name, "admin");
    assert.deepEqual(a.store.calls.slice(clean), ["get"]);
    await (
      await rebuilder(w, a)
    )();
    const pending = a.store.calls.length;
    assert.equal(await a.read("absent"), undefined);
    await check.reading;
    assert.equal(await a.read("absent"), undefined);
    assert.equal(a.store.calls.slice(pending).filter((call) => call === "runId").length, 1);
  },
);

test(
  "an abandoned newer revision does not end the suspension during a live rollout of the next one",
  {
    timeout: 10_000,
  },
  async () => {
    const old = world({ database: new Map([["r1", role("r1", "admin")]]) });
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const reviewedV2 = gate();
    const rebuilt = gate();
    const a = await instance(
      old,
      store,
      bus,
      lockWith(shared, (name) => {
        if (name === "test:role:v2:hydration") {
          reviewedV2.open();
        }
      }),
    );
    old.load.started = rebuilt.open;
    const finishRollout = await rolloutInProgress(store, shared);
    await markRevision(store, "test:role:v3", "loading");
    try {
      await a.bus.channel.publish({ type: "changes", origin: "external", keyspace: "test:role:v3", changes: [] });
      await Promise.race([reviewedV2.opened, rebuilt.opened]);
      assert.equal((await a.read("r1"))?.name, "admin");
      assert.equal(old.reads.byId, 1);
    } finally {
      await a.app.stop();
      await finishRollout();
    }
    assert.deepEqual(
      {
        loads: old.reads.list,
        v2: store.markers.get("test:role:v2")?.state,
        v3: store.markers.has("test:role:v3"),
        ready: a.bus.published.filter(isReady).length,
      },
      { loads: 1, v2: "loading", v3: false, ready: 1 },
    );
  },
);

/**
 * One network round trip of an asynchronous store, the only timer in this file, because tests prove an absence: a
 * stop that has not returned before a drop lands, and no store call after a load that settles after stop. No promise
 * or event fires for what does not happen, so no gate can end such a wait; each use says why at its fake. Every
 * microtask of the work before it has run by then, so correct code cannot fail by timing, but work deferred past this
 * one turn goes unseen.
 */
const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const late of ["value", "failure"] as const) {
  test(
    `stop does not wait for an in-flight load, and its late ${late} goes nowhere`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const w = world({ startup: "background" });
      w.database.set("r1", role("r1", "admin"));
      const store = memoryStore();
      const shared = memoryLock();
      const load = gate();
      const started = gate();
      w.load.started = started.open;
      w.load.gates.push(load.opened);
      if (late === "failure") {
        w.load.failures = 1;
      }
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const a = await instance(w, store, memoryBus(), shared);
      t.after(async () => {
        load.open();
        process.off("unhandledRejection", onUnhandled);
        await a.app.stop();
      });
      await started.opened;
      const lease = shared.leases[0];
      assert.ok(lease);
      await a.app.stop();
      await lease.finished;
      const calls = a.store.calls.length;
      const attempts = a.bus.attempts.length;
      load.open();
      // A late store call is an absence: awaiting the load's own gate returns before that call, so it would go unseen.
      // This read back takes one store round trip, and sees only what the late load does within that one turn.
      const observer = store.connect().store;
      const nativeGet = observer.get;
      observer.get = async (...args) => {
        await roundTrip();
        return nativeGet(...args);
      };
      const readBack = await observer.get("test:role:v1", "role", "r1");
      assert.deepEqual(
        {
          calls: a.store.calls.slice(calls),
          attempts: a.bus.attempts.slice(attempts),
          marker: store.markers.get("test:role:v1")?.state,
          stored: readBack,
          unhandled,
        },
        { calls: [], attempts: [], marker: "loading", stored: undefined, unhandled: [] },
      );
    },
  );
}

test("a Unit of Work reads its own write back through the shared layer", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const saveThenRead = command<Role>()({
    requirements: { saveRole, findRole },
    run: async (value, ctx) => {
      await ctx.saveRole(value);
      return success(await ctx.findRole(value.id));
    },
  });
  const a = await instance(w, store, bus, shared, [saveThenRead]);
  t.after(() => a.app.stop());
  const inside = await a.app.withScope((scope) => scope.resolve(saveThenRead)(role("r1", "root", 1)));
  assert.ok(!inside.isError);
  assert.deepEqual(inside.value, role("r1", "root", 2));
});

test("a second read failure recovers like the first", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  t.after(() => a.app.stop());
  const local = await a.local();
  for (const round of [1, 2]) {
    // A miss in the instance layer reaches the real shared read wrapper.
    local.clear();
    a.store.failNextGet();
    assert.equal((await a.read("r1"))?.name, "admin");
    assert.equal(await a.health(), "down");
    const reloaded = nextReload(w, local);
    assert.equal((await a.read("r1"))?.name, "admin");
    await reloaded;
    assert.equal(await a.health(), "up", `round ${round}`);
  }
  const sourceReads = w.reads.byId;
  local.clear();
  assert.equal((await a.read("r1"))?.name, "admin");
  assert.equal(w.reads.byId, sourceReads);
});

for (const owed of ["a pending rebuild", "a failed instance layer"] as const) {
  test(
    `stop after store restoration does not wait for the check a ready commit started for ${owed}`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const { w, store, bus, shared } = setup({ roles: twoRoles });
      const traces = failureTraces();
      const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild, traces.provider]);
      const crashed = gate();
      let holding: Promise<unknown> = Promise.resolve();
      if (owed === "a pending rebuild") {
        holding = shared.tryRun(hydrationLock, { leaseMs: 60_000 }, () => crashed.opened);
        await (
          await rebuilder(w, a)
        )();
      } else {
        const failed = traces.next();
        failNextPersist(w, "set");
        await a.save(role("r1", "root", 1));
        await failed;
      }
      const marker = store.holdNextMarker();
      // The test deadline only releases a regressed stop for cleanup; it never makes the test pass.
      t.signal.addEventListener("abort", marker.release, { once: true });
      t.after(async () => {
        marker.release();
        crashed.open();
        await a.app.stop();
      });
      // The marker reply stays held, so this proves the commit does not wait for the check it starts.
      assert.equal((await a.save(role("r2", "viewer", 1))).isError, false);
      await marker.reading;
      a.store.lose();
      crashed.open();
      await holding;
      const reloaded = fullReload(w, await a.local());
      a.store.restore();
      await reloaded;
      assert.equal((await a.read("r2"))?.name, "viewer");
      const stopping = a.app.stop();
      await a.bus.closed;
      await stopping;
    },
  );
}

test("a reload's older list does not overwrite a commit's refresh", { timeout: 10_000 }, async (t) => {
  const { w, store, bus, shared } = setup();
  const a = await instance(w, store, bus, shared);
  const listed = gate();
  const answer = gate();
  t.after(async () => {
    answer.open();
    await a.app.stop();
  });
  const local = await a.local();
  const persisted = (version: number) =>
    new Promise<void>((resolve) => {
      const watch = (map: Map<string, Role>, changes: readonly CacheChange[]) => {
        if (
          map !== local ||
          !changes.some((change) => change.type === "set" && (change.value as Role).version === version)
        ) {
          return;
        }
        w.watchers.delete(watch);
        resolve();
      };
      w.watchers.add(watch);
    });
  await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: "test:role:v1" });
  // A store may answer out of order: this list is read before the commit and answered after its refresh.
  const nativeList = a.store.store.list;
  a.store.store.list = async (...args) => {
    a.store.store.list = nativeList;
    const values = await nativeList(...args);
    listed.open();
    await answer.opened;
    return values;
  };
  await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: "test:role:v1" });
  await listed.opened;
  const refreshed = persisted(2);
  await a.save(role("r1", "root", 1));
  await refreshed;
  const olderList = persisted(1);
  const refreshedAgain = persisted(2);
  answer.open();
  await olderList;
  assert.equal((await a.read("r1"))?.version, 2);
  await refreshedAgain;
  assert.deepEqual(
    { local: local.get("r1")?.version, read: (await a.read("r1"))?.version, sourceReads: w.reads.byId },
    { local: 2, read: 2, sourceReads: 0 },
  );
});

/** The next store read of a connection: issued now, reads the store on linearize and answers on reply, as an out-of-order store may. */
function heldGet(each: Running) {
  const native = each.store.store.get;
  const issued = gate();
  const linearize = gate();
  const linearized = gate();
  const reply = gate();
  each.store.store.get = async (...args) => {
    each.store.store.get = native;
    issued.open();
    await linearize.opened;
    const value = await native(...args);
    linearized.open();
    await reply.opened;
    return value;
  };
  return {
    issued: issued.opened,
    reply: reply.open,
    release() {
      linearize.open();
      reply.open();
    },
    async read() {
      linearize.open();
      await linearized.opened;
    },
  };
}

/** A peer's rebuild, past its marker and clear and held in its load; the returned call finishes it. */
async function peerRebuilding(w: World, peer: Running): Promise<() => Promise<void>> {
  const load = gate();
  const started = gate();
  w.load.started = started.open;
  w.load.gates.push(load.opened);
  const rebuilt = (await rebuilder(w, peer))();
  await started.opened;
  return async () => {
    load.open();
    await rebuilt;
  };
}

for (const reply of ["absence", "a value"] as const) {
  test(`a store reply older than a peer's whole rebuild is not used: ${reply}`, { timeout: 10_000 }, async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    const b = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
    const local = await a.local();
    const refreshed = nextReload(w, local);
    await a.save(role("r1", "root", 1));
    await refreshed;
    // A miss in the instance layer reaches the shared read wrapper.
    local.clear();
    const get = heldGet(a);
    let finish = async () => undefined as void;
    t.after(async () => {
      get.release();
      await finish();
      await Promise.all([a.app.stop(), b.app.stop()]);
    });
    const reading = a.read("r1");
    await get.issued;
    if (reply === "a value") {
      await get.read();
    }
    finish = await peerRebuilding(w, b);
    if (reply === "absence") {
      await get.read();
    }
    const reloaded = nextReload(w, local);
    await finish();
    await reloaded;
    // The source moves on, so only a read of the source answers the newest version.
    if (reply === "a value") {
      w.database.set("r1", role("r1", "newest", 3));
    }
    get.reply();
    assert.equal((await reading)?.version, w.database.get("r1")?.version);
  });
}

for (const reads of ["a key", "a list"] as const) {
  test(
    `a read while a peer's clear message has not arrived answers from the source: ${reads}`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const w = world({ members: { list: true }, localInclude: () => true });
      w.database.set("r1", role("r1", "admin"));
      const store = memoryStore();
      const bus = memoryBus();
      const shared = memoryLock();
      const a = await instance(w, store, bus, shared);
      const b = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
      const local = await a.local();
      let finish = async () => undefined as void;
      t.after(async () => {
        await finish();
        await Promise.all([a.app.stop(), b.app.stop()]);
      });
      const refreshed = nextReload(w, local);
      await a.save(role("r1", "root", 1));
      await refreshed;
      local.clear();
      a.bus.drop("clear");
      finish = await peerRebuilding(w, b);
      const committed = role("r1", "root", 2);
      assert.equal(store.markers.get("test:role:v1")?.state, "loading");
      if (reads === "a key") {
        assert.deepEqual(await a.read("r1"), committed);
      } else {
        assert.deepEqual(await listFrom(a), [committed]);
      }
      // The peer's ready brings this instance back, without the clear it never received.
      const reloaded = nextReload(w, local);
      await finish();
      await reloaded;
      const sourceReads = w.reads.byId;
      assert.deepEqual(await a.read("r1"), committed);
      assert.equal(w.reads.byId, sourceReads);
      assert.equal(await a.health(), "up");
    },
  );
}

const sharedKeyspace = "test:role:v1";
for (const [member, reuse] of [
  ["get", false],
  ["list", false],
  ["get", true],
  ["list", true],
] as const) {
  test(
    `a ${member} reply taken during an unseen whole rebuild cannot claim completeness${reuse ? " with reused completed lock tokens" : ""}`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const w = world({ members: { list: true }, localInclude: () => true });
      w.database.set("r1", role("r1", "admin"));
      const store = memoryStore();
      const bus = memoryBus();
      const native = memoryLock();
      const outstanding = new Set<number>();
      const tokens: string[] = [];
      const shared: Lock = reuse
        ? {
            tryRun: (name, options, work) =>
              native.tryRun(name, options, async () => {
                let index = 0;
                while (outstanding.has(index)) {
                  index++;
                }
                outstanding.add(index);
                const token = `holder-${index}`;
                tokens.push(token);
                try {
                  return await work({ token });
                } finally {
                  outstanding.delete(index);
                }
              }),
          }
        : native;
      const a = await instance(w, store, bus, shared);
      const b = await instance(w, store, bus, shared, [w.roleReplication.rebuild]);
      const refreshed = nextReload(w, await a.local());
      await a.save(role("r1", "root", 1));
      await refreshed;
      (await a.local()).clear();
      const before = store.markers.get(sharedKeyspace);
      a.bus.drop("clear");
      a.bus.drop("ready");
      const issued = gate();
      const linearize = gate();
      const taken = gate();
      const reply = gate();
      let finish = async () => undefined as void;
      t.after(async () => {
        linearize.open();
        reply.open();
        await finish();
        await Promise.all([a.app.stop(), b.app.stop()]);
      });
      const read = async <T>(native: () => Promise<T>) => {
        issued.open();
        await linearize.opened;
        const value = await native();
        taken.open();
        await reply.opened;
        return value;
      };
      if (member === "get") {
        const native = a.store.store.get;
        a.store.store.get = (...args) => read(() => native(...args));
      } else {
        const native = a.store.store.list;
        a.store.store.list = (...args) => read(() => native(...args));
      }
      const reading = member === "get" ? a.read("r1") : listFrom(a);
      await issued.opened;
      finish = await peerRebuilding(w, b);
      linearize.open();
      await taken.opened;
      await finish();
      reply.open();
      const answer = await reading;
      t.diagnostic(
        JSON.stringify({ tokens, before, after: store.markers.get(sharedKeyspace), answer: answer ?? null }),
      );
      if (reuse) {
        assert.deepEqual(tokens, ["holder-0", "holder-0"]);
      }
      assert.deepEqual(answer, member === "get" ? role("r1", "root", 2) : [role("r1", "root", 2)]);
    },
  );
}

for (const [name, change] of [
  ["the marker this instance verified", (marker) => marker],
  ["a loading marker", (marker) => ({ ...marker, state: "loading" })],
  ["a dirty marker", (marker) => ({ ...marker, dirty: true })],
  ["a marker of another run", (marker) => ({ ...marker, runId: "another" })],
  ["a marker of another holder", (marker) => ({ ...marker, holder: "another" })],
  ["no marker", () => undefined],
] as const satisfies readonly (readonly [string, (marker: ReplicaMarker) => ReplicaMarker | undefined])[]) {
  test(`absence from the shared layer with ${name}`, { timeout: 10_000 }, async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    t.after(() => a.app.stop());
    const late = role("late", "only in the source");
    w.database.set("late", late);
    const marker = store.markers.get(sharedKeyspace);
    assert.ok(marker);
    const changed = change(marker);
    if (changed === undefined) {
      store.markers.delete(sharedKeyspace);
    } else {
      store.markers.set(sharedKeyspace, changed);
    }
    const confirmed = name === "the marker this instance verified";
    const calls = a.store.calls.length;
    const first = await a.read("late");
    const firstCalls = a.store.calls.slice(calls);
    // Unconfirmed, the instance is out of ready, so the next read does not reach the store's states at all.
    const beforeSecond = a.store.calls.length;
    await a.read("late");
    assert.deepEqual(
      {
        first,
        firstCalls,
        secondReadsStates: a.store.calls.slice(beforeSecond).includes("get"),
        sourceReads: w.reads.byId,
      },
      {
        first: confirmed ? undefined : late,
        firstCalls: ["get", "marker"],
        secondReadsStates: confirmed,
        sourceReads: confirmed ? 0 : 2,
      },
    );
  });
}

for (const event of ["a peer's clear", "a peer's ready", "a newer revision", "a lost store"] as const) {
  test(`absence is not answered when ${event} overtakes its marker read`, { timeout: 10_000 }, async (t) => {
    const { w, store, bus, shared } = setup();
    const a = await instance(w, store, bus, shared);
    const confirming = store.holdNextMarker();
    t.after(async () => {
      confirming.release();
      a.store.restore();
      await a.app.stop();
    });
    const late = role("late", "only in the source");
    w.database.set("late", late);
    const reading = a.read("late");
    await confirming.reading;
    if (event === "a lost store") {
      a.store.lose();
    } else {
      const keyspace = event === "a newer revision" ? "test:role:v2" : sharedKeyspace;
      await a.bus.channel.publish({
        type: event === "a peer's ready" ? "ready" : "clear",
        origin: "external",
        keyspace,
      });
      // The marker it answers with is the one this instance verified.
      confirming.release();
    }
    assert.deepEqual(await reading, late);
  });
}

test(
  "a failed marker read of an absence answers from the source and recovers on the next read",
  {
    timeout: 10_000,
  },
  async (t) => {
    const { w, store, bus, shared } = setup();
    const traces = failureTraces();
    const a = await instance(w, store, bus, shared, [traces.provider]);
    t.after(() => a.app.stop());
    const late = role("late", "only in the source");
    w.database.set("late", late);
    const native = a.store.store.marker;
    a.store.store.marker = async () => {
      a.store.store.marker = native;
      throw new Error("marker unavailable");
    };
    const failed = traces.next();
    assert.deepEqual(await a.read("late"), late);
    await failed;
    const afterFailure = await a.health();
    const reloaded = nextReload(w, await a.local());
    await a.read("late");
    await reloaded;
    assert.deepEqual(
      {
        afterFailure,
        recovered: await a.health(),
        failures: traces.failures.map((failure) => (failure as Error).message),
      },
      { afterFailure: "down", recovered: "up", failures: ["marker unavailable"] },
    );
  },
);

test("only a shared answer that claims completeness reads the marker", { timeout: 10_000 }, async (t) => {
  const w = world({ members: { list: true }, localInclude: () => true });
  w.database.set("r1", role("r1", "admin"));
  const a = await instance(w, memoryStore(), memoryBus(), memoryLock());
  const partial = world({ include: visible });
  partial.database.set("r1", role("r1", "admin"));
  const b = await instance(partial, memoryStore(), memoryBus(), memoryLock());
  t.after(() => Promise.all([a.app.stop(), b.app.stop()]));
  (await a.local()).clear();
  const cost = async (each: Running, read: () => Promise<unknown>) => {
    const calls = each.store.calls.length;
    await read();
    return each.store.calls.slice(calls);
  };
  assert.deepEqual(
    {
      value: await cost(a, () => a.read("r1")),
      absence: await cost(a, () => a.read("absent")),
      list: await cost(a, () => listFrom(a)),
      partialAbsence: await cost(b, () => b.read("absent")),
    },
    { value: ["get"], absence: ["get", "marker"], list: ["list", "marker"], partialAbsence: ["get"] },
  );
});

for (const state of ["ready with a pending rebuild", "not ready"] as const) {
  test(
    `a commit's failed check on an instance ${state} reports and sends reads to the source`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const { w, store, bus, shared } = setup();
      const traces = failureTraces();
      const a = await instance(w, store, bus, shared, [w.roleReplication.rebuild, traces.provider]);
      const crashed = gate();
      let holding: Promise<unknown> = Promise.resolve();
      t.after(async () => {
        crashed.open();
        await holding;
        await a.app.stop();
      });
      if (state === "not ready") {
        await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: sharedKeyspace });
      } else {
        holding = shared.tryRun(hydrationLock, { leaseMs: 60_000 }, () => crashed.opened);
        await (
          await rebuilder(w, a)
        )();
      }
      const native = a.store.store.runId;
      a.store.store.runId = async () => {
        a.store.store.runId = native;
        throw new Error("check failed");
      };
      const failed = traces.next();
      const saved = await a.save(role("r1", "root", 1));
      await failed;
      assert.deepEqual(
        {
          isError: saved.isError,
          failures: traces.failures.map((failure) => (failure as Error).message),
          health: await a.health(),
          read: (await a.read("r1"))?.version,
          sourceReads: w.reads.byId,
        },
        { isError: false, failures: ["check failed"], health: "down", read: 2, sourceReads: 1 },
      );
    },
  );
}

for (const overtaken of ["a refresh", "a retried reload", "a reload after a clear", "a clear"] as const) {
  test(
    `an instance read started after a command and older than ${overtaken} answers the committed state`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const taken = gate();
      const reply = gate();
      let hold = false;
      const w = world({
        localRead: async (value) => {
          if (!hold) {
            return value;
          }
          hold = false;
          taken.open();
          await reply.opened;
          // Enabling a key emits nothing a gate could wait for; this reply lands after whatever that work has enabled.
          await roundTrip();
          return value;
        },
      });
      w.database.set("r1", role("r1", "admin"));
      const store = memoryStore();
      const bus = memoryBus();
      const traces = failureTraces();
      const a = await instance(w, store, bus, memoryLock(), [traces.provider]);
      const local = await a.local();
      const refreshing = a.store.holdNextGet();
      t.after(async () => {
        refreshing.release();
        reply.open();
        await a.app.stop();
      });
      if (overtaken === "a retried reload") {
        refreshing.release();
        const failed = traces.next();
        failNextPersist(w, "set");
        await a.save(role("r1", "root", 1));
        await failed;
        // The failed write left the older state in the instance store.
        local.set("r1", role("r1", "admin"));
      } else {
        await a.save(role("r1", "root", 1));
        await refreshing.reading;
      }
      const done = overtaken === "a clear" ? Promise.resolve() : nextReload(w, local);
      hold = true;
      const reading = a.read("r1");
      await taken.opened;
      if (overtaken === "a refresh") {
        refreshing.release();
      }
      if (overtaken === "a clear" || overtaken === "a reload after a clear") {
        await a.bus.channel.publish({ type: "clear", origin: "external", keyspace: sharedKeyspace });
      }
      if (overtaken === "a reload after a clear") {
        await a.bus.channel.publish({ type: "ready", origin: "external", keyspace: sharedKeyspace });
      }
      await done;
      reply.open();
      assert.equal((await reading)?.version, 2);
    },
  );
}

test(
  "a reload invalidates an older instance reply while another key's last pass is still held",
  {
    timeout: 10_000,
  },
  async (t) => {
    const taken = gate();
    const reply = gate();
    let held = false;
    const w = world({
      localRead: async (value) => {
        if (held && value?.id === "r2") {
          held = false;
          taken.open();
          await reply.opened;
        }
        return value;
      },
    });
    for (const value of twoRoles) {
      w.database.set(value.id, value);
    }
    const store = memoryStore();
    const bus = memoryBus();
    const shared = memoryLock();
    const traces = failureTraces();
    const a = await instance(w, store, bus, shared, [traces.provider]);
    const b = await instance(w, store, bus, shared);
    // Keep the one-shot persist failure on a, rather than the peer's concurrent refresh.
    b.bus.drop("changes");
    const marker = store.holdNextMarker();
    let releasePass = () => undefined as void;
    t.after(async () => {
      marker.release();
      releasePass();
      reply.open();
      await Promise.all([a.app.stop(), b.app.stop()]);
    });
    // Fail r1's refresh so the next read retries the instance reload.
    const failed = traces.next();
    failNextPersist(w, "set");
    await a.save(role("r1", "root", 1));
    await failed;
    held = true;
    const reading = a.read("r2");
    await taken.opened;
    await marker.reading;
    // r2's notification is still in flight when the retry's list takes the committed r2.
    a.bus.drop("changes");
    assert.equal((await b.save(role("r2", "viewer", 1))).isError, false);
    const pass = a.store.holdNextGet();
    releasePass = pass.release;
    marker.release();
    await pass.reading;
    // No key has been enabled by a refresh since this read started; r1's last pass remains held.
    reply.open();
    assert.deepEqual(await reading, role("r2", "viewer", 2));
  },
);
