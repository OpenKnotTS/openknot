import { logger } from "@openknot-ts/logging/wire";
import { config, resource, unit } from "@openknot-ts/wire";
import type { Requirements, RequirementsOptions, ResolvedReferences, CancellationOptions } from "@openknot-ts/wire";
import { Connection } from "rabbitmq-client";
import { z } from "zod";

const integer = z.string().regex(/^\d+$/).transform(Number);
// Node timers accept at most a signed 32-bit number of milliseconds.
const timerMs = integer.pipe(z.int().positive().max(2_147_483_647));

export const rabbitConfig = config({
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/, error: "must be an amqp:// or amqps:// URL" }),
  RABBITMQ_STARTUP_TIMEOUT_MS: timerMs.default(10_000),
  RABBITMQ_HEARTBEAT_SECONDS: integer.pipe(z.int().nonnegative()).default(60),
  RABBITMQ_ACQUIRE_TIMEOUT_MS: timerMs.default(20_000),
});

/**
 * Receives the failures the integration cannot return to a caller: connection errors, topology recovery and listener
 * deliveries that never reached Flow. Writes through the application's `logger` by default; bind it with
 * `unit({ provides: rabbitErrors, factory })` to report them elsewhere.
 */
export const rabbitErrors = unit({
  requirements: { logger },
  factory:
    ({ logger }) =>
    (error: unknown): void => {
      logger.error("RabbitMQ failure", { error });
    },
});

/** Owns the native connection returned by create, including every SDK option and inferred custom member. */
export function rabbitClient<const R extends Requirements = {}, C extends Connection = Connection>(
  options: RequirementsOptions<R> & {
    readonly create: (dependencies: ResolvedReferences<R>, acquisition: CancellationOptions) => C;
    readonly startupTimeoutMs?: (dependencies: ResolvedReferences<R>) => number;
  },
) {
  return resource({
    requirements: { ...options.requirements, __report: rabbitErrors } as R & { readonly __report: typeof rabbitErrors },
    async initialize(dependencies, acquisition) {
      const { signal } = acquisition;
      signal.throwIfAborted();
      const report = dependencies.__report as (error: unknown) => void;
      const timeoutMs = options.startupTimeoutMs?.(dependencies) ?? 10_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
        throw new TypeError("Rabbit startup timeout must be a positive signed 32-bit integer.");
      }
      const connection = options.create(dependencies, acquisition);
      connection.on("error", report);

      const connected = Promise.withResolvers<void>();
      const onConnection = () => connected.resolve();

      connection.on("connection", onConnection);

      const timer = setTimeout(() => connected.reject(new Error("RabbitMQ connection startup timed out")), timeoutMs);

      const cancelled = Promise.withResolvers<never>();

      const abort = () => {
        connection.unsafeDestroy();
        cancelled.reject(signal.reason);
      };

      signal.addEventListener("abort", abort, { once: true });

      try {
        signal.throwIfAborted();
        if (!connection.ready) {
          await Promise.race([connected.promise, cancelled.promise]);
        }
        signal.throwIfAborted();
        return { value: connection, release: () => connection.close() };
      } catch (error) {
        connection.unsafeDestroy();
        throw error;
      } finally {
        clearTimeout(timer);
        connection.off("connection", onConnection);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}

/** Acquired once per application, automatically through topology requirements. */
export const rabbit = rabbitClient({
  requirements: { config: rabbitConfig },
  create: ({ config }) =>
    new Connection({
      url: config.RABBITMQ_URL,
      heartbeat: config.RABBITMQ_HEARTBEAT_SECONDS,
      acquireTimeout: config.RABBITMQ_ACQUIRE_TIMEOUT_MS,
    }),
  startupTimeoutMs: ({ config }) => config.RABBITMQ_STARTUP_TIMEOUT_MS,
});
