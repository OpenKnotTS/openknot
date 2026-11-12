import type { Logger, Logging } from "./index.ts";
import { consoleLogging, createLogger, LoggerMarker, parseLogLevel } from "./index.ts";
import { traceCorrelation } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { config, optional, unit } from "@openknot-ts/wire";
import type { OptionalDependency, Provider } from "@openknot-ts/wire";

export const loggingConfig = config({ LOG_LEVEL: parseLogLevel });

/** Writes records on the console until an implementation provides it. */
export const logging = unit({ factory: (): Logging => consoleLogging });

export interface LoggerReference extends Provider<
  Logger,
  never,
  "unit",
  {
    readonly logging: typeof logging;
    readonly loggingConfig: typeof loggingConfig;
    readonly tracing: OptionalDependency<typeof trace>;
  }
> {
  readonly [LoggerMarker]: true;
}

/**
 * What operations, handlers and plugs declare: `requirements: { logger }`. With a tracing implementation bound, each
 * record carries the active span's `traceId` and `spanId`.
 */
export const logger: LoggerReference = Object.freeze({
  ...unit({
    requirements: { logging, loggingConfig, tracing: optional(trace) },
    factory: ({ logging, loggingConfig, tracing }) =>
      createLogger(logging, {
        level: loggingConfig.LOG_LEVEL,
        correlation: tracing === undefined ? undefined : () => traceCorrelation(tracing),
      }),
  }),
  [LoggerMarker]: true as const,
});
