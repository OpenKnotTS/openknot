import { redisConnections } from "../examples/native.ts";
import { redisReplicaStoreOf, redisReplicationChannelOf } from "../src/index.ts";
import { reader, success } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/behavior/wire";
import type { CacheChange } from "@openknot-ts/cache";
import type { Upserted } from "@openknot-ts/flow";
import { command, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import type { Lock } from "@openknot-ts/lock";
import { lock } from "@openknot-ts/lock/wire";
import { redisLockOf } from "@openknot-ts/redis-lock";
import { replicaStore, replication, replicationChannel } from "@openknot-ts/replication";
import { composeModule, defineApplication, plug, resource, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const url = process.env.REDIS_URL ?? "";
const skip = url === "" ? "set REDIS_URL to run against Redis" : false;

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
  readonly version: number;
}

/** Settles with the work, or rejects once the test times out, so a failing test still stops its instances. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener("abort", abort));
}

test(
  "two instances share one Redis: one hydration, commits and rebuilds reach the other's instance layer",
  { skip, timeout: 30_000 },
  async (t) => {
    const namespace = `openknot-test:${randomUUID()}`;
    const database = new Map<string, Role>([["r1", { entity: "role", id: "r1", name: "admin", version: 1 }]]);
    const reads = { byId: 0, list: 0 };
    const attempts: boolean[] = [];
    const findRole = reader<(id: string) => Promise<Role | undefined>>();
    const listRoles = reader<() => Promise<readonly Role[]>>();
    const saveRole = writer<(value: Role) => Promise<Upserted<Role>>>();
    const roleReaders = plug({
      port: reader.compose({ byId: findRole, list: listRoles }),
      bind: () => ({
        byId: async (id: string) => {
          reads.byId++;
          return database.get(id);
        },
        list: async () => {
          reads.list++;
          return [...database.values()];
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
    const persisted = new Set<(local: Map<string, Role>, changes: readonly CacheChange[]) => void>();
    const localRoles = unit({ factory: () => new Map<string, Role>() });
    const rolesLocal = replication.instance({
      requirements: { localRoles },
      port: reader.compose({ byId: findRole }),
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
          for (const watch of persisted) {
            watch(local, changes);
          }
        },
      bind: ({ localRoles: local }) => ({ byId: (id: string) => local.get(id) }),
    });
    const rolesShared = replication.distributed({
      entity: "role",
      port: reader.compose({ byId: findRole }),
      namespace,
      load: listRoles,
      startup: "blocking",
    });
    const roleReplication = replication({ roleReaders, rolesLocal, rolesShared });
    const save = command<Role>()({
      requirements: { saveRole },
      run: async (value, ctx) => success(await ctx.saveRole(value)),
    });
    const counted = (inner: Lock): Lock => ({
      async tryRun(name, options, work) {
        const result = await inner.tryRun(name, options, work);
        attempts.push(result.acquired);
        return result;
      },
    });

    async function instance() {
      const redis = resource({
        async initialize() {
          const connections = await redisConnections(url);
          return { value: connections, release: () => connections.close() };
        },
      });
      const providers: readonly object[] = [
        ...Object.values(roleReplication),
        saves,
        save,
        unit({
          provides: replicaStore,
          requirements: { redis },
          factory: ({ redis }) => redisReplicaStoreOf(redis.commands, { prefix: namespace }),
        }),
        unit({
          provides: replicationChannel,
          requirements: { redis },
          factory: ({ redis }) => redisReplicationChannelOf(redis, { channel: namespace }),
        }),
        unit({
          provides: lock,
          requirements: { redis },
          factory: ({ redis }) => counted(redisLockOf(redis.commands, { prefix: namespace })),
        }),
      ];
      const app = await runApplication(
        defineApplication({ modules: [composeModule({ providers: providers.map((source) => ({ source })) })] }),
        { stopOn: [] },
      );
      return {
        app,
        read: (id: string) => app.withScope((scope) => scope.resolve(findRole)(id)),
        save: (value: Role) => app.withScope((scope) => scope.resolve(save)(value)),
        local: app.resolve(localRoles),
        rebuild: () => app.resolve(roleReplication.rebuild)(),
      };
    }

    /** Resolves with the instance layer once it persisted a matching change; subscribe before the action. */
    function nextPersisted(local: Map<string, Role>, type: CacheChange["type"]): Promise<Role | undefined> {
      return until(
        new Promise((resolve) => {
          const watch = (map: Map<string, Role>, changes: readonly CacheChange[]) => {
            if (map === local && changes.some((change) => change.type === type)) {
              persisted.delete(watch);
              resolve(map.get("r1"));
            }
          };
          persisted.add(watch);
        }),
        t.signal,
      );
    }

    // Closed handles leave libuv in the close phase that follows the current turn of the event loop.
    const resources = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return process.getActiveResourcesInfo().sort();
    };
    const before = await resources();
    const [a, b] = await Promise.all([instance(), instance()]);
    try {
      // Both start at once; the lock lets one of them load the source into Redis.
      assert.equal(reads.list, 1);
      assert.deepEqual(attempts.toSorted(), [false, true]);
      assert.equal((await b.read("r1"))?.name, "admin");
      assert.equal(reads.byId, 0);

      // A's commit is stored in Redis and announced; B refreshes its instance layer from Redis, not from the source.
      const refreshed = nextPersisted(b.local, "set");
      await a.save({ ...database.get("r1")!, name: "manager" });
      assert.deepEqual(await refreshed, { entity: "role", id: "r1", name: "manager", version: 2 });
      assert.equal((await b.read("r1"))?.name, "manager");
      assert.equal(reads.byId, 0);

      // A's rebuild reloads Redis from the source under the lock; B clears its instance layer and reloads it.
      const cleared = nextPersisted(b.local, "clear");
      const reloaded = nextPersisted(b.local, "set");
      await a.rebuild();
      await cleared;
      assert.deepEqual(await reloaded, { entity: "role", id: "r1", name: "manager", version: 2 });
      assert.equal(reads.list, 2);
    } finally {
      await Promise.all([a.app.stop(), b.app.stop()]);
      const connections = await redisConnections(url);
      try {
        const keys = (await connections.commands.sendCommand(["KEYS", `${namespace}*`])) as string[];
        if (keys.length > 0) {
          await connections.commands.sendCommand(["DEL", ...keys]);
        }
      } finally {
        await connections.close();
      }
    }
    // Stopped instances leave no connection, subscription or timer behind.
    assert.deepEqual(await resources(), before);
  },
);
