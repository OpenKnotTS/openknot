import { createExecutionLogs } from "../execution-logs.ts";
import type { LogLevel } from "@openknot-ts/logging";
import { parseLogLevel } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import { trace } from "@openknot-ts/tracing/wire";
import { config, optional, unit } from "@openknot-ts/wire";

/** An unset or empty variable leaves its kind unlogged. */
function level(value: string | undefined): LogLevel | undefined {
  return value === undefined || value.trim() === "" ? undefined : parseLogLevel(value);
}

function flag(value: string | undefined): boolean {
  switch (value?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "false":
      return false;
    case "true":
      return true;
    default:
      throw new TypeError("Expected true or false.");
  }
}

export const executionLoggingConfig = config({
  LOG_LEVEL_EXPOSE: level,
  LOG_LEVEL_LISTENER: level,
  LOG_LEVEL_SCHEDULER: level,
  LOG_LEVEL_COMMAND: level,
  LOG_LEVEL_QUERY: level,
  LOG_LEVEL_GUARD: level,
  LOG_LEVEL_HOOK: level,
  LOG_LEVEL_UNIT_OF_WORK: level,
  LOG_LEVEL_PUBLISH: level,
  LOG_LEVEL_SUBSCRIBE: level,
  LOG_DURATION: flag,
});

export const executionLogs = unit({
  requirements: { logging, executionLoggingConfig, tracing: optional(trace) },
  factory: ({ logging, executionLoggingConfig: values, tracing }) =>
    createExecutionLogs(
      logging,
      {
        expose: values.LOG_LEVEL_EXPOSE,
        listener: values.LOG_LEVEL_LISTENER,
        scheduler: values.LOG_LEVEL_SCHEDULER,
        command: values.LOG_LEVEL_COMMAND,
        query: values.LOG_LEVEL_QUERY,
        guard: values.LOG_LEVEL_GUARD,
        hook: values.LOG_LEVEL_HOOK,
        "unit-of-work": values.LOG_LEVEL_UNIT_OF_WORK,
        publish: values.LOG_LEVEL_PUBLISH,
        subscribe: values.LOG_LEVEL_SUBSCRIBE,
      },
      values.LOG_DURATION,
      tracing,
    ),
});
