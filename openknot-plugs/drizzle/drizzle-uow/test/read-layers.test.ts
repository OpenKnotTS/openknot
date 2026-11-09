import { drizzleUnitOfWork } from "../src/index.ts";
import { createClient } from "@libsql/client";
import { failure, reader } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/behavior/wire";
import type { CacheChange } from "@openknot-ts/cache";
import { cache } from "@openknot-ts/cache";
import type { Upserted } from "@openknot-ts/flow";
import { command, defaultUnitOfWork, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { lock } from "@openknot-ts/lock/wire";
import type { ReplicaChange, ReplicaMarker, ReplicaStore, ReplicationHandlers } from "@openknot-ts/replication";
import { replicaStore, replication, replicationChannel } from "@openknot-ts/replication";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

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
const port = reader.compose({ byId: findRole, list: listRoles });

const roles = sqliteTable("roles", {
  entity: text("entity").$type<"role">().notNull(),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
});

function connected(definitions: readonly object[]) {
  return runApplication(
    defineApplication({ modules: [composeModule({ providers: definitions.map((source) => ({ source })) })] }),
  );
}

async function fixture(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "openknot-drizzle-read-layers-"));
  const url = `file:${join(folder, "roles.db")}`;
  const writerClient = createClient({ url });
  const readerClient = createClient({ url });
  t.after(async () => {
    writerClient.close();
    readerClient.close();
    await rm(folder, { recursive: true, force: true });
  });
  await writerClient.execute("PRAGMA journal_mode = WAL");
  await writerClient.execute(
    "CREATE TABLE roles (entity TEXT NOT NULL, id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL)",
  );
  const primary = drizzle({ client: writerClient });
  const database = drizzle({ client: readerClient });
  await primary.insert(roles).values(role("r1", "admin"));
  const uow = drizzleUnitOfWork({ database: primary });
  const current = () => uow.session ?? database;
  const saves = plug({
    port: saveRole,
    bind: () => async (value: Role) => {
      const stored = { ...value, version: value.version + 1 };
      const [saved] = await (
        await uow.current()
      )
        .insert(roles)
        .values(stored)
        .onConflictDoUpdate({ target: roles.id, set: stored })
        .returning();
      assert.ok(saved);
      return upserted(saved);
    },
  });
  return { database, uow, saves, current };
}

for (const inside of [true, false]) {
  test(
    `a cache recovery started by a read ${inside ? "inside" : "outside"} a transaction stores no uncommitted row`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const { database, uow, saves, current } = await fixture(t);
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
          byId: async (id: string) => (await current().select().from(roles).where(eq(roles.id, id)))[0],
          list: async () => current().select().from(roles),
        }),
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
      const app = await connected([
        reads,
        ...Object.values(layer),
        saves,
        vetoed,
        plug({ port: defaultUnitOfWork, bind: () => uow }),
      ]);
      try {
        storeReadFails = true;
        await app.withScope((scope) => scope.resolve(findRole)("r2"));
        assert.equal((await app.withScope((scope) => scope.resolve(vetoed)())).isError, true);
        assert.deepEqual(await database.select().from(roles).where(eq(roles.id, "phantom")), []);
        if (!inside) {
          await app.withScope((scope) => scope.resolve(findRole)("r1"));
          await recovered();
        }
        assert.deepEqual([...memory.keys()], ["r1"]);
      } finally {
        await app.stop();
      }
    },
  );
}

function sharedStore() {
  const markers = new Map<string, ReplicaMarker>();
  const states = new Map<string, unknown>();
  const store: ReplicaStore = {
    runId: async () => "run",
    marker: async (keyspace) => markers.get(keyspace),
    mark: async (keyspace, marker) => {
      markers.set(keyspace, marker);
    },
    apply: async (_keyspace, changes: readonly ReplicaChange[]) => {
      for (const change of changes) {
        if (change.type === "set") {
          states.set(String(change.id), change.value);
        } else {
          states.delete(String(change.id));
        }
      }
      return changes;
    },
    clear: async () => states.clear(),
    get: async (_keyspace, _entity, id) => states.get(String(id)),
    list: async () => [...states.values()],
    drop: async () => undefined,
  };
  return { store, states };
}

for (const inside of [true, false]) {
  test(
    `a hydration started by a read ${inside ? "inside" : "outside"} a transaction stores no uncommitted row`,
    {
      timeout: 10_000,
    },
    async (t) => {
      const { database, uow, saves, current } = await fixture(t);
      const { store, states } = sharedStore();
      const subscribers = new Set<ReplicationHandlers>();
      const hydrated = Promise.withResolvers<void>();
      let loadFailures = 1;
      const roleReaders = plug({
        port,
        bind: () => ({
          byId: async (id: string) => (await current().select().from(roles).where(eq(roles.id, id)))[0],
          list: async () => {
            if (loadFailures-- > 0) {
              throw new Error("source unavailable");
            }
            return current().select().from(roles);
          },
        }),
      });
      const roleReplication = replication({
        roleReaders,
        rolesShared: replication.distributed({
          entity: "role",
          port: reader.compose({ byId: findRole }),
          namespace: "test:role",
          load: listRoles,
          startup: "blocking",
        }),
      });
      const vetoed = command({
        requirements: { saveRole, findRole },
        run: async (_, ctx) => {
          await ctx.saveRole(role("phantom", "ghost", 0));
          if (inside) {
            await ctx.findRole("r1");
            await hydrated.promise;
          }
          return failure(new Error("veto"));
        },
      });
      const app = await connected([
        ...Object.values(roleReplication),
        saves,
        vetoed,
        plug({ port: defaultUnitOfWork, bind: () => uow }),
        unit({ provides: replicaStore, factory: () => store }),
        unit({
          provides: replicationChannel,
          factory: () => ({
            subscribe: async (handlers: ReplicationHandlers) => {
              subscribers.add(handlers);
              return { close: async () => void subscribers.delete(handlers) };
            },
            publish: async (message: { readonly type: string }) => {
              if (message.type === "ready") {
                hydrated.resolve();
              }
            },
          }),
        }),
        unit({
          provides: lock,
          factory: () => ({
            tryRun: async <T>(_name: string, _options: unknown, work: (lease: { token: string }) => Promise<T>) => ({
              acquired: true as const,
              value: await work({ token: "holder" }),
            }),
          }),
        }),
      ]);
      try {
        assert.equal((await app.withScope((scope) => scope.resolve(vetoed)())).isError, true);
        assert.deepEqual(await database.select().from(roles).where(eq(roles.id, "phantom")), []);
        if (!inside) {
          await app.withScope((scope) => scope.resolve(findRole)("r1"));
          await hydrated.promise;
        }
        assert.deepEqual([...states.keys()], ["r1"]);
      } finally {
        await app.stop();
      }
    },
  );
}
