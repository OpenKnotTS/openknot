/** Recognises an error, as every OpenKnot `error()` factory does; a custom `{ is }` selects by any rule. */
export interface ErrorKind {
  is(error: unknown): boolean;
}

/** A failure that reached a boundary: an execution's result, or a failure no caller receives. */
export interface ErrorReport {
  readonly error: unknown;
  /** Where it failed: an execution's kind, such as `openknot.listener`, or a plug, such as `openknot.rabbitmq`. */
  readonly source: string;
  /**
   * An execution's anticipated failure, such as an authored business error or a version conflict. Unexpected
   * failures, and failures with no caller, are not expected.
   */
  readonly expected: boolean;
  /** The definition that failed, for application-selected grouping. */
  readonly reference?: object | undefined;
  /** What identifies the failing instance, such as a cache's name or an execution's message id. */
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export type ErrorReporter = (report: ErrorReport) => void;

/** A failure no caller receives: where it failed, and what identifies the failing instance. */
export type UnattendedFailure = Pick<ErrorReport, "error" | "source" | "attributes">;

export type UnattendedFailures = (failure: UnattendedFailure) => void;

/** Every unexpected failure, and the expected ones that `errors` selects. */
export function isReported(report: ErrorReport, errors: readonly ErrorKind[] = []): boolean {
  return !report.expected || errors.some((kind) => kind.is(report.error));
}

/**
 * Delivers a report to the application's reporter, when one is bound. Reporting never fails the work that reports: a
 * reporter's own failure goes to the console with the report.
 */
export function reportError(reporter: ErrorReporter | undefined, report: ErrorReport): void {
  if (reporter === undefined) {
    return;
  }
  try {
    reporter(report);
  } catch (failure) {
    console.error("[openknot/error-reporting] The error reporter failed", failure, report.error);
  }
}
