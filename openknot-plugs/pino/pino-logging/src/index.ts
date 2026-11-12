import type { LogRecord, Logging } from "@openknot-ts/logging";
import type { Logger } from "pino";
import { stdSerializers } from "pino";

/**
 * Writes records through the application's pino instance, which owns format, destination and flushing. `LOG_LEVEL`
 * selects records before they reach pino, so the instance's own level should not be stricter.
 */
export function pinoLogging(instance: Logger): Logging {
  // Records carry errors under `error`; pino serializes only `err` by default.
  const target = instance.child({}, { serializers: { error: stdSerializers.err } });

  return Object.freeze({
    write({ level, message, attributes }: LogRecord): void {
      target[level](attributes, message);
    },
  });
}
