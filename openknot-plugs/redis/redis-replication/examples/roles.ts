import { redisReplicaStoreOf } from "../src/index.ts";
import { redisReplicaStore, redisReplicationChannel } from "../src/wire.ts";
import { redisConnections } from "./native.ts";
import { reader, success } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/behavior/wire";
import type { Upserted } from "@openknot-ts/flow";
import { command, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { redisLock } from "@openknot-ts/redis-lock/wire";
import { replication } from "@openknot-ts/replication";
import { composeModule, defineApplication, plug, resource, runApplication, unit } from "@openknot-ts/wire";
import { randomUUID } from "node:crypto";

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
  readonly version: number;
}

const findRole = reader<(id: string) => Promise<Role | undefined>>();
const listRoles = reader<() => Promise<readonly Role[]>>();
const saveRole = writer<(role: Role) => Promise<Upserted<Role>>>();

async function run(url: string): Promise<void> {
  const database = new Map<string, Role>();
  let sourceReads = 0;
  const namespace = `example-${randomUUID()}:role`;

  // Two Redis connections: one for commands, one for the subscription
  const connection = () =>
    resource({
      initialize: async () => {
        const opened = await redisConnections(url);
        return { value: opened, release: () => opened.close() };
      },
    });

  const redis = connection();
  const subscriber = connection();

  // The source of truth
  const roleReaders = plug({
    port: reader.compose({ byId: findRole, list: listRoles }),
    bind: () => ({
      byId: async (id: string) => {
        sourceReads++;
        return database.get(id);
      },
      list: async () => [...database.values()],
    }),
  });

  // Read layers: a per-instance map in front of a shared Redis keyspace
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

  // Writes
  const roleWriters = plug({
    port: saveRole,
    bind: () => async (role: Role) => {
      const saved = { ...role, version: role.version + 1 };
      database.set(saved.id, saved);
      return upserted(saved);
    },
  });

  const saveRoleCommand = command<Role>()({
    requirements: { saveRole },
    run: async (role, ctx) => {
      const saved = await ctx.saveRole(role);
      return success(saved.next);
    },
  });

  const providers = [
    ...Object.values(roleReplication),
    roleWriters,
    saveRoleCommand,

    // Redis implementations of the replication store, channel and lock
    redisReplicaStore({ requirements: { redis }, commands: ({ redis: own }) => own.commands }),
    redisReplicationChannel({
      requirements: { redis, subscriber },
      connections: ({ redis: own, subscriber: listening }) => ({
        commands: own.commands,
        subscriber: listening.subscriber,
      }),
    }),
    redisLock({ requirements: { redis }, commands: ({ redis: own }) => own.commands }),
  ];

  const start = () =>
    runApplication(
      defineApplication({ modules: [composeModule({ providers: providers.map((source) => ({ source })) })] }),
    );

  // Two instances: a write on the first is read from Redis by the second.
  const first = await start();
  const second = await start();

  await first.withScope((scope) =>
    scope.resolve(saveRoleCommand)({ entity: "role", id: "r1", name: "admin", version: 0 }),
  );

  const seen = await second.withScope((scope) => scope.resolve(findRole)("r1"));
  console.log(
    `The second instance read ${seen?.name} at version ${seen?.version}; the source answered ${sourceReads} reads.`,
  );

  await Promise.all([first.stop(), second.stop()]);

  const cleanup = await redisConnections(url);
  await redisReplicaStoreOf(cleanup.commands).drop(`${namespace}:v1`);
  await cleanup.close();
}

const url = process.env.REDIS_URL;

if (url === undefined) {
  console.log("Set REDIS_URL to run the replication example against Redis.");
} else {
  await run(url);
}
