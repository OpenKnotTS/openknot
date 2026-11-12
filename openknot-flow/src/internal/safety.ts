import type { FlowExecutionError } from "../errors.ts";
import { InputCancelledError, InternalFlowError, PostCommitError, UnitOfWorkError } from "../errors.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { InternalBehaviorError } from "@openknot-ts/behavior";
import type { Classification } from "@openknot-ts/behavior/internal/safety";
import { classify, requireOutcome } from "@openknot-ts/behavior/internal/safety";
import { VersionConflict } from "@openknot-ts/versioning";

/** Where Flow hands a result to a plug: Flow keeps Outcomes, a plug sees the value or the classified failure thrown. */
export function requireSuccess<T>(result: Outcome<T, Error>): T {
  if (result.isError) {
    throw result.error;
  }
  return result.value;
}

/** Also used for overridden guards, which bypass the original executor. */
export function requireGuardOutcome(value: unknown): asserts value is Outcome<void, Error> {
  requireVoidOutcome(value, "Guard run() must return an Outcome with a void success");
}

export function requireVoidOutcome(value: unknown, message: string): asserts value is Outcome<void, Error> {
  requireOutcome(value, message);
  if (!value.isError && value.value !== undefined) {
    throw new TypeError(message);
  }
}

/** Failures a framework boundary already classified, Behavior's included; a later Flow boundary keeps them. */
const flowErrors: Classification<FlowExecutionError>["classified"] = [
  VersionConflict,
  InternalBehaviorError,
  InternalFlowError,
  InputCancelledError,
  UnitOfWorkError,
  PostCommitError,
];

const classification: Classification<FlowExecutionError> = {
  classified: flowErrors,
  internal: InternalFlowError,
  cancelled: InputCancelledError,
};

export function isClassified(error: unknown): error is FlowExecutionError {
  return flowErrors.some((kind) => kind.is(error));
}

const defects = [InternalBehaviorError, InternalFlowError, UnitOfWorkError, PostCommitError];

/**
 * A failure no business rule anticipates, as opposed to an authored failure, a version conflict or a cancellation: an
 * execution log writes it at `error` with the error itself, and an error reporter receives it as unexpected.
 */
export function isDefect(error: unknown): boolean {
  return defects.some((kind) => kind.is(error));
}

/**
 * A plug's failure is infrastructure for the execution that called it: a classified Flow error it carries belongs to
 * another execution, so it becomes this one's internal failure. `VersionConflict` is the versioning contract's own
 * failure and keeps its identity. While this execution is cancelled, any failure of
 * its port calls is that cancellation.
 */
export function plugFailure(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted === true) {
    return signal.reason;
  }
  return isClassified(error) && !VersionConflict.is(error) ? InternalFlowError(error) : error;
}

/** Flow's classification of a failure its work throws, given the execution's signal. */
export function executionError(error: unknown, signal?: AbortSignal): FlowExecutionError {
  return classify(error, classification, signal);
}

/**
 * A scope cleanup failure after the execution settled. It never hides what the execution established: when its
 * result stands, as a committed execution's does, it is a PostCommitError, otherwise an internal failure; both
 * keep the settled failure in their cause.
 */
export function cleanupError(
  settled: Outcome<unknown, Error>,
  error: unknown,
  stands = !settled.isError || PostCommitError.is(settled.error),
): PostCommitError | InternalFlowError {
  const cause = settled.isError
    ? new AggregateError([settled.error, error], "Execution failed and scope cleanup also failed", { cause: error })
    : error;
  return stands ? PostCommitError("completion", cause) : InternalFlowError(cause);
}
