import type { HealthCheckDefinition } from "@openknot-ts/health";
import { healthCheck } from "@openknot-ts/health";
import type {
  CancellationOptions,
  ManagedResource,
  Provider,
  Requirements,
  RequirementsOptions,
  ResolvedReferences,
} from "@openknot-ts/wire";
import { resource } from "@openknot-ts/wire";
import type { Pool } from "pg";

/**
 * Ends a pool once every connection it opened has closed. `end()` settles once no client is checked out, and
 * `totalCount` drops before a socket closes, so connections are counted from `connect` to their own `remove`.
 */
function closing(pool: Pool): () => Promise<void> {
  // Connections the application opened in `create`, before these listeners attached, count as well.
  let open = pool.totalCount;
  const waiting = new Set<() => void>();
  pool.on("connect", () => {
    open++;
  });
  pool.on("remove", () => {
    if (--open === 0) {
      for (const resolve of waiting) {
        resolve();
      }
    }
  });
  return async () => {
    const closed = open === 0 ? undefined : new Promise<void>((resolve) => waiting.add(resolve));
    await pool.end();
    await closed;
  };
}

/**
 * Settles with the work, or rejects as soon as the signal aborts. The work goes on, and a failure it reports after the
 * abort is ignored.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      work.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * A native node-postgres pool as an application resource. The application creates the pool with its own settings and
 * error handling; acquisition checks out one connection, so an unreachable server fails startup, and a failed or
 * cancelled startup and the release end the pool once.
 */
export function postgresClient<const R extends Requirements = {}, P extends Pool = Pool>(
  options: RequirementsOptions<R> & {
    readonly create: (dependencies: ResolvedReferences<R>, options: CancellationOptions) => P | PromiseLike<P>;
  },
) {
  return resource({
    ...options,
    async initialize(dependencies: ResolvedReferences<R>, acquisition) {
      const pool = await options.create(dependencies, acquisition);
      const close = closing(pool);
      let ending: Promise<void> | undefined;
      const end = () => (ending ??= close());

      // node-postgres cannot cancel a connection attempt, and `end()` waits for it, so a cancelled startup stops
      // waiting at once and the pool ends when the attempt settles, within the pool's `connectionTimeoutMillis`.
      try {
        acquisition.signal.throwIfAborted();
        await untilAborted(
          pool.connect().then((connection) => connection.release()),
          acquisition.signal,
        );
      } catch (error) {
        await untilAborted(end(), acquisition.signal).catch(() => undefined);
        throw error;
      }

      return { value: pool, release: end };
    },
  });
}

/** An active check of a PostgreSQL resource: `SELECT 1` succeeds within the check's deadline. */
export function postgresHealthCheck(options: {
  readonly postgres: Provider<ManagedResource<Pick<Pool, "query">>, never, "resource">;
  readonly name?: string;
  readonly timeoutMs?: number;
}): HealthCheckDefinition<{ readonly postgres: typeof options.postgres }> {
  const { postgres, name = "postgres", timeoutMs } = options;
  return healthCheck({
    name,
    requirements: { postgres },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    check: async ({ postgres }) => {
      await postgres.query("SELECT 1");
      return "up";
    },
  });
}
