import type { ErrorReporter, UnattendedFailures } from "./index.ts";
import { reportError } from "./index.ts";
import { logger } from "@openknot-ts/logging/wire";
import { optional, unit } from "@openknot-ts/wire";

/**
 * Implementations provide it with ordinary Wire composition, such as `provideSentry()`; Flow and plugs consume
 * `optional(errorReporter)` and report nothing until one is bound. Logging stays with the application's logger.
 */
export const errorReporter = unit.contract<ErrorReporter>();

/**
 * What a plug or capability hands a failure no caller receives, such as a lost connection or a failed background
 * round: it is always written through the application's `logger` at `error` as `<source> failed`, with its attributes,
 * and reported as unexpected to the error reporter when one is bound. Rebinding it handles every such failure elsewhere.
 */
export const unattendedFailures = unit({
  requirements: { logger, reporter: optional(errorReporter) },
  factory:
    ({ logger, reporter }): UnattendedFailures =>
    ({ error, source, attributes }) => {
      logger.error(`${source} failed`, { ...attributes, error });
      reportError(reporter, { error, source, expected: false, attributes });
    },
});
