import { createExecutionLogs } from "../execution-logs.ts";
import type { LogLevel } from "@openknot-ts/logging";
import { isLogLevel } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import { trace } from "@openknot-ts/tracing/wire";
import { config, optional, unit } from "@openknot-ts/wire";

/** An unset or empty variable keeps its kind's default; `off` leaves the kind unlogged. */
function level(fallback: LogLevel | undefined) {
  return (value: string | undefined): LogLevel | undefined => {
    const configured = value?.trim().toLowerCase();
    if (configured === undefined || configured === "") {
      return fallback;
    }
    if (configured === "off") {
      return undefined;
    }
    if (!isLogLevel(configured)) {
      throw new TypeError("Expected off, trace, debug, info, warn, error or fatal.");
    }
    return configured;
  };
}

/**
 * Every execution starts at an input, so no failure stays silent: an exposure or subscription returns its failures to
 * a caller, whose transport answers a defect without logging it; a listener or scheduler has no caller at all.
 */
const called = level("error");
const unattended = level("warn");
const nested = level(undefined);

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
  LOG_LEVEL_EXPOSE: called,
  LOG_LEVEL_SUBSCRIBE: called,
  LOG_LEVEL_LISTENER: unattended,
  LOG_LEVEL_SCHEDULER: unattended,
  LOG_LEVEL_COMMAND: nested,
  LOG_LEVEL_QUERY: nested,
  LOG_LEVEL_GUARD: nested,
  LOG_LEVEL_HOOK: nested,
  LOG_LEVEL_UNIT_OF_WORK: nested,
  LOG_LEVEL_PUBLISH: nested,
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
