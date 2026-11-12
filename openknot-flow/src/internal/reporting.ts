import { InputCancelledError, InternalFlowError, PostCommitError, UnitOfWorkError } from "../errors.ts";
import type { ExecutionTrace } from "./tracing.ts";
import { InternalBehaviorError } from "@openknot-ts/behavior";
import type { ErrorReport, ErrorReporter } from "@openknot-ts/error-reporting";
import { reportError } from "@openknot-ts/error-reporting";

/** Failures no business rule anticipates, which an error reporter always receives. */
const unexpectedErrors = [InternalBehaviorError, InternalFlowError, UnitOfWorkError, PostCommitError];

/** An input's settled failure, for the application's reporter when one is bound; the caller's own cancellation is none. */
export function reportFailure(
  reporter: ErrorReporter | undefined,
  operation: Pick<ExecutionTrace, "kind" | "reference">,
  error: Error,
  attributes?: ErrorReport["attributes"],
): void {
  if (InputCancelledError.is(error)) {
    return;
  }
  reportError(reporter, {
    error,
    source: `openknot.${operation.kind}`,
    expected: !unexpectedErrors.some((kind) => kind.is(error)),
    reference: operation.reference,
    attributes,
  });
}
