import type { InternalBehaviorError } from "@openknot-ts/behavior";
import { error } from "@openknot-ts/behavior";
import type { VersionConflict } from "@openknot-ts/versioning";

export const ActorAuthenticationError = error("ActorAuthenticationError", () => ({
  message: "The supplied credentials are invalid",
}));
export interface ActorAuthenticationError extends ReturnType<typeof ActorAuthenticationError> {}

type TransactionStatus = "rolled-back" | "unknown";
type CommittedPhase = "changes" | "effects" | "publications" | "completion";

export const InternalFlowError = error("InternalFlowError", (cause: unknown) => ({
  message: "Unexpected flow execution failure",
  cause,
}));
export interface InternalFlowError extends ReturnType<typeof InternalFlowError> {}

export const InputUnavailableError = error("InputUnavailableError", () => ({
  message: "The input plug or application is not accepting invocations",
}));
export interface InputUnavailableError extends ReturnType<typeof InputUnavailableError> {}

export const InputCancelledError = error("InputCancelledError", (cause: unknown) => ({
  message: "Input invocation was cancelled",
  cause,
}));
export interface InputCancelledError extends ReturnType<typeof InputCancelledError> {}

export const UnitOfWorkError = error(
  "UnitOfWorkError",
  (message: string, options?: { readonly cause?: unknown; readonly transactionStatus?: TransactionStatus }) => ({
    message,
    ...(options !== undefined && "cause" in options ? { cause: options.cause } : {}),
    transactionStatus: options?.transactionStatus,
  }),
);
export interface UnitOfWorkError extends ReturnType<typeof UnitOfWorkError> {}

export const PostCommitError = error("PostCommitError", (phase: CommittedPhase, cause: unknown) => ({
  message: `Unit of Work committed; ${phase} failed`,
  cause,
  committed: true as const,
  phase,
}));
export interface PostCommitError extends ReturnType<typeof PostCommitError> {}

/** What a Flow execution may fail with besides its authored errors, including Behavior's own internal failure. */
export type FlowExecutionError =
  | InternalBehaviorError
  | InternalFlowError
  | InputCancelledError
  | UnitOfWorkError
  | PostCommitError
  | VersionConflict;
