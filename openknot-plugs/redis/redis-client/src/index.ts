import type { UnattendedFailures } from "@openknot-ts/error-reporting";
import { unattendedFailures } from "@openknot-ts/error-reporting/wire";
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

export type RedisManagedClient = Pick<RedisClientType, "close" | "destroy" | "isReady"> & {
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

/**
 * Closes a client for release: a ready client first receives the replies to the commands it already sent. node-redis
 * settles `close()` only on a reply or on `destroy()`, so a client that is not ready, which no reply can reach, is
 * destroyed at once, and a connection that fails while closing ends the wait with its error.
 */
async function closed(client: RedisManagedClient): Promise<void> {
  try {
    if (client.isReady) {
      const failed = Promise.withResolvers<never>();
      const fail = (error: unknown) => failed.reject(error);
      client.on("error", fail);
      try {
        await Promise.race([client.close(), failed.promise]);
      } finally {
        client.off("error", fail);
      }
    }
  } finally {
    client.destroy();
  }
}

/**
 * Hands a client's failures no caller receives to `unattendedFailures`, once per outage: an error is reported only when
 * the client has been ready since the last one. Errors before its first ready fail acquisition instead. Its error
 * listener also keeps node-redis from throwing an error that no listener receives. Returns the removal of its listeners.
 */
function reportOutages(client: RedisManagedClient, report: UnattendedFailures, name: string): () => void {
  let ready = false;
  const restored = () => {
    ready = true;
  };
  const lost = (error: unknown) => {
    if (ready) {
      ready = false;
      report({ error, source: "openknot.redis", attributes: { "openknot.redis.client": name } });
    }
  };
  client.on("ready", restored);
  client.on("error", lost);
  return () => {
    client.off("ready", restored);
    client.off("error", lost);
  };
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
    requirements: { ...options.requirements, __failures: unattendedFailures } as R & {
      readonly __failures: typeof unattendedFailures;
    },
    async initialize(dependencies, acquisition) {
      const clients = await options.create(dependencies, acquisition);
      // A client that serves both roles is named by its commands role.
      const names = new Map<RedisManagedClient, string>([[clients.commands, "commands"]]);
      if (!names.has(clients.subscriber)) {
        names.set(clients.subscriber, "subscriber");
      }
      const native = [...names.keys()];
      const unwatch = [...names].map(([client, name]) =>
        reportOutages(client, dependencies.__failures as UnattendedFailures, name),
      );
      const ignore = () => {
        for (const remove of unwatch) {
          remove();
        }
      };
      const abort = () => {
        for (const client of native) {
          client.destroy();
        }
        ignore();
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
          // A failure while closing ends the release with it, which reports it instead.
          ignore();
          const results = await Promise.allSettled(native.map(closed));

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
