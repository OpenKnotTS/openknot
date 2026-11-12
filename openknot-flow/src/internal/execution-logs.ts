import { InternalFlowError } from "../errors.ts";
import { tagOf } from "./tag.ts";
import type { ExecutionTrace, ExecutionTraceKind } from "./tracing.ts";
import { outcomeError, traceExecution } from "./tracing.ts";
import { InternalBehaviorError } from "@openknot-ts/behavior";
import type { LogAttributes, LogLevel, Logger, Logging } from "@openknot-ts/logging";
import { createLogger } from "@openknot-ts/logging";
import type { Tracing } from "@openknot-ts/tracing";
import { traceCorrelation } from "@openknot-ts/tracing";

/** One logger per enabled execution kind, each at the level the application configured for that kind. */
export interface ExecutionLogs {
  readonly loggers: Readonly<Partial<Record<ExecutionTraceKind, Logger>>>;
  readonly duration: boolean;
}

/** Undefined when no kind is enabled, so executions run without a wrapper. */
export function createExecutionLogs(
  logging: Logging,
  levels: Readonly<Record<ExecutionTraceKind, LogLevel | undefined>>,
  duration: boolean,
  tracing: Tracing | undefined,
): ExecutionLogs | undefined {
  const correlation = tracing === undefined ? undefined : () => traceCorrelation(tracing);
  const loggers: Partial<Record<ExecutionTraceKind, Logger>> = {};
  for (const [kind, level] of Object.entries(levels) as [ExecutionTraceKind, LogLevel | undefined][]) {
    if (level !== undefined) {
      loggers[kind] = createLogger(logging, { level, correlation });
    }
  }
  return Object.keys(loggers).length === 0 ? undefined : Object.freeze({ loggers: Object.freeze(loggers), duration });
}

function errorType(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "type" in error) {
    return error.type;
  }
  return error instanceof Error ? error.name : typeof error;
}

/** A defect the framework classified, as opposed to a failure the application returned or a cancellation. */
function internal(error: unknown): boolean {
  return InternalFlowError.is(error) || InternalBehaviorError.is(error);
}

/**
 * Started at debug, succeeded at info, a returned failure at warn with its type, a defect at error with the error
 * itself. Inputs, outputs and actors are never written.
 */
async function logExecution<T>(
  logger: Logger,
  duration: boolean,
  operation: Pick<ExecutionTrace, "kind" | "reference">,
  work: () => Promise<T>,
): Promise<T> {
  const tag = tagOf(operation.reference);
  const name = tag === undefined ? operation.kind : `${operation.kind} ${tag}`;
  const identity: LogAttributes = tag === undefined ? { kind: operation.kind } : { kind: operation.kind, tag };
  const started = duration ? performance.now() : 0;
  const completed = (attributes: LogAttributes): LogAttributes =>
    duration
      ? { ...identity, durationMs: Math.round((performance.now() - started) * 100) / 100, ...attributes }
      : { ...identity, ...attributes };

  logger.debug(`${name} started`, identity);

  let result: T;
  try {
    result = await work();
  } catch (error) {
    logger.error(`${name} threw`, completed({ error }));
    throw error;
  }

  const failure = outcomeError(result);

  if (failure === undefined) {
    logger.info(`${name} succeeded`, completed({}));
  } else if (internal(failure)) {
    logger.error(`${name} failed`, completed({ errorType: errorType(failure), error: failure }));
  } else {
    logger.warn(`${name} failed`, completed({ errorType: errorType(failure) }));
  }
  return result;
}

/** Every traced execution passes here: the log records it inside its span, so implementations can correlate them. */
export function observeExecution<T>(
  tracing: Tracing | undefined,
  logs: ExecutionLogs | undefined,
  operation: ExecutionTrace,
  work: () => Promise<T>,
): Promise<T> {
  const logger = logs?.loggers[operation.kind];

  if (logs === undefined || logger === undefined) {
    return traceExecution(tracing, operation, work);
  }
  
  return traceExecution(tracing, operation, () => logExecution(logger, logs.duration, operation, work));
}
