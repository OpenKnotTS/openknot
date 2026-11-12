import type { ErrorReporter, UnattendedFailures } from "./index.ts";
import { logger } from "@openknot-ts/logging/wire";
import { optional, unit } from "@openknot-ts/wire";

/**
 * Implementations provide it with ordinary Wire composition, such as `provideSentry()`; Flow and plugs hand their reports
 * to `errorReports`, which reports nothing until one is bound. Logging stays with the application's logger.
 */
export const errorReporter = unit.contract<ErrorReporter>();

/**
 * Delivers a report to the application's reporter when one is bound. Reporting never fails the work that reports: a
 * reporter's own failure is logged through the application's `logger` with the error it was reporting.
 */
export const errorReports = unit({
  requirements: { logger, reporter: optional(errorReporter) },
  factory: ({ logger, reporter }): ErrorReporter =>
    reporter === undefined
      ? () => undefined
      : (report) => {
          try {
            reporter(report);
          } catch (failure) {
            logger.error("openknot.error-reporting failed", { error: failure, reported: report.error });
          }
        },
});

/**
 * What a plug or capability hands a failure no caller receives, such as a lost connection or a failed background
 * round: it is always written through the application's `logger` at `error` as `<source> failed`, with its attributes,
 * and reported as unexpected to the error reporter when one is bound. Rebinding it handles every such failure elsewhere.
 */
export const unattendedFailures = unit({
  requirements: { logger, report: errorReports },
  factory:
    ({ logger, report }): UnattendedFailures =>
    ({ error, source, attributes }) => {
      logger.error(`${source} failed`, { ...attributes, error });
      report({ error, source, expected: false, attributes });
    },
});
