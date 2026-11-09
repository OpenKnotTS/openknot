import type { HealthCheckDefinition } from "@openknot-ts/health";
import { healthCheck } from "@openknot-ts/health";
import type {
  CancellationOptions,
  ConnectionWatch,
  ManagedResource,
  Provider,
  Requirements,
  RequirementsOptions,
  ResolvedReferences,
} from "@openknot-ts/wire";
import { connectionWatch, resource } from "@openknot-ts/wire";
import type { RedisClient, RedisClientType } from "redis";

/** Raw command replies are untrusted until the adapter decodes them. */
export type RedisCommands = {
  sendCommand(...args: Parameters<RedisClientType["sendCommand"]>): ReturnType<RedisClientType["sendCommand"]>;
};

export type RedisSubscriber = {
  subscribe: typeof RedisClient.prototype.subscribe<false>;
  unsubscribe: typeof RedisClient.prototype.unsubscribe<false>;
  on(...args: Parameters<RedisClientType["on"]>): void;
  off(...args: Parameters<RedisClientType["off"]>): void;
};

export interface RedisConnections {
  readonly commands: RedisCommands;
  readonly subscriber: RedisSubscriber;
}

export type RedisManagedClient = Pick<RedisClientType, "close" | "destroy"> & {
  connect(...args: Parameters<RedisClientType["connect"]>): Promise<unknown>;
  on(...args: Parameters<RedisClientType["on"]>): void;
  off(...args: Parameters<RedisClientType["off"]>): void;
};

export function redisConnectionOf(client: RedisCommands & RedisManagedClient): ConnectionWatch {
  return connectionWatch(({ lost, restored }) => {
    client.on("reconnecting", lost);
    client.on("end", lost);
    client.on("ready", restored);
    return () => {
      client.off("reconnecting", lost);
      client.off("end", lost);
      client.off("ready", restored);
    };
  });
}

/**
 * An active check of a Redis resource: it sends PING and reports up only for PONG. The check's deadline, `timeoutMs`,
 * reports down and aborts the check's signal, which withdraws a PING still waiting to be sent, such as during a
 * reconnection.
 */
export function redisHealthCheck(options: {
  readonly redis: Provider<ManagedResource<{ readonly commands: RedisCommands }>, never, "resource">;
  readonly name?: string;
  readonly timeoutMs?: number;
}): HealthCheckDefinition<{ readonly redis: typeof options.redis }> {
  const { redis, name = "redis", timeoutMs } = options;
  return healthCheck({
    name,
    requirements: { redis },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    check: async ({ redis }, { signal }) =>
      (await redis.commands.sendCommand(["PING"], { abortSignal: signal })) === "PONG" ? "up" : "down",
  });
}

/**
 * Connects a client for acquisition: its first error before it is ready fails the acquisition, as an unreachable server
 * fails other native drivers, instead of waiting for a reconnection that may never come. Once ready, the client's own
 * reconnection strategy applies.
 */
async function connected(client: RedisManagedClient): Promise<void> {
  const failed = Promise.withResolvers<never>();
  const fail = (error: unknown) => failed.reject(error);
  client.on("error", fail);
  try {
    const connecting = client.connect();
    // A failed acquisition destroys the client, which rejects the abandoned connection attempt.
    connecting.catch(() => undefined);
    await Promise.race([connecting, failed.promise]);
  } finally {
    client.off("error", fail);
  }
}

export function redisClient<const R extends Requirements = {}, C extends RedisConnections = RedisConnections>(
  options: RequirementsOptions<R> & {
    readonly create: (
      dependencies: ResolvedReferences<R>,
      options: CancellationOptions,
    ) =>
      | (C & {
          readonly commands: RedisCommands & RedisManagedClient;
          readonly subscriber: RedisSubscriber & RedisManagedClient;
        })
      | PromiseLike<
          C & {
            readonly commands: RedisCommands & RedisManagedClient;
            readonly subscriber: RedisSubscriber & RedisManagedClient;
          }
        >;
  },
) {
  return resource({
    ...options,
    async initialize(dependencies: ResolvedReferences<R>, acquisition) {
      const clients = await options.create(dependencies, acquisition);
      const native = [...new Set([clients.commands, clients.subscriber])];
      const abort = () => {
        for (const client of native) {
          client.destroy();
        }
      };

      acquisition.signal.addEventListener("abort", abort, { once: true });

      try {
        acquisition.signal.throwIfAborted();

        const results = await Promise.allSettled(native.map(connected));
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));

        acquisition.signal.throwIfAborted();

        if (failures.length > 0) {
          throw new AggregateError(failures, "Redis acquisition failed");
        }
      } catch (error) {
        abort();
        throw error;
      } finally {
        acquisition.signal.removeEventListener("abort", abort);
      }
      const connection = redisConnectionOf(clients.commands);
      return {
        value: Object.assign(clients, { connection }),
        async release() {
          const results = await Promise.allSettled(
            native.map(async (client) => {
              try {
                await client.close();
              } finally {
                client.destroy();
              }
            }),
          );

          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
          );

          if (failures.length > 0) {
            throw new AggregateError(failures, "Redis release failed");
          }
        },
      };
    },
  });
}
