import type { ReplicaCommands, ReplicaStoreOptions, ReplicaSubscriber } from "./index.ts";
import { redisReplicaStoreOf, redisReplicationChannelOf } from "./index.ts";
import { replicationChannel, replicaStore } from "@openknot-ts/replication";
import type { Requirements, RequirementsOptions, ResolvedReferences } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";

export function redisReplicaStore<const R extends Requirements = {}>(
  options: RequirementsOptions<R> &
    Omit<ReplicaStoreOptions, "connection"> & {
      readonly commands: (dependencies: ResolvedReferences<R>) => ReplicaCommands;
      readonly connection?: (dependencies: ResolvedReferences<R>) => NonNullable<ReplicaStoreOptions["connection"]>;
      readonly options?: (dependencies: ResolvedReferences<R>) => Omit<ReplicaStoreOptions, "connection">;
    },
) {
  const { commands, connection, requirements, options: select, ...settings } = options;
  return unit({
    provides: replicaStore,
    requirements: (requirements ?? {}) as R,
    factory: (dependencies: ResolvedReferences<R>) =>
      redisReplicaStoreOf(commands(dependencies), {
        ...settings,
        ...select?.(dependencies),
        ...(connection === undefined ? {} : { connection: connection(dependencies) }),
      }),
  });
}

export function redisReplicationChannel<const R extends Requirements = {}>(
  options: RequirementsOptions<R> & {
    readonly connections: (dependencies: ResolvedReferences<R>) => {
      readonly commands: ReplicaCommands;
      readonly subscriber: ReplicaSubscriber;
    };
    readonly channel?: string | ((dependencies: ResolvedReferences<R>) => string);
  },
) {
  return unit({
    provides: replicationChannel,
    requirements: (options.requirements ?? {}) as R,
    factory: (dependencies: ResolvedReferences<R>) => {
      const channel = typeof options.channel === "function" ? options.channel(dependencies) : options.channel;
      return redisReplicationChannelOf(options.connections(dependencies), channel === undefined ? {} : { channel });
    },
  });
}
