import { InputCancelledError } from "../errors.ts";
import type { GuardDefinition, GuardExecutionOptions, Guards } from "../guard.ts";
import { GuardRun, guardInputReader } from "../guard.ts";
import type { ExecutionLifetime } from "./cancellation.ts";
import { executionLifetime } from "./cancellation.ts";
import type { ExecutionEnvironment } from "./execution-runtime.ts";
import { executionError, requireGuardOutcome } from "./safety.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { failure, success } from "@openknot-ts/behavior";
import { protectAsync } from "@openknot-ts/behavior/internal/safety";

export type RuntimeGuard = (input: unknown, options?: GuardExecutionOptions) => Promise<Outcome<void, Error>>;

/** One request's guard check: each guard receives its named input, in declaration order, failing fast. */
export type GuardCheck = (
  resolve: (definition: GuardDefinition) => RuntimeGuard,
  signal: AbortSignal,
) => Promise<Outcome<void, Error>>;

/**
 * Shared admission for every port that supports named guards, which it reads once. Admitting a request reads
 * its guard inputs at once, so a malformed request fails before a scope opens; the check runs in the scope.
 */
export function guardAdmission(guards: Guards): (request: object) => GuardCheck {
  const entries = Object.entries(guards);
  const read = guardInputReader(guards);
  return (request) => {
    const inputs = read(request);
    return async (resolve, signal) => {
      for (const [name, definition] of entries) {
        if (signal.aborted) {
          return failure(InputCancelledError(signal.reason));
        }
        const checked = await resolve(definition)(inputs[name], { signal });
        requireGuardOutcome(checked);
        if (checked.isError) {
          return checked;
        }
      }
      return success();
    };
  };
}

/** Captures resolved dependencies, while every invocation receives its own signal. */
export function createGuardExecutor(
  definition: GuardDefinition,
  dependencies: object,
  environment?: ExecutionEnvironment,
): RuntimeGuard {
  const uow = environment?.uow;
  return async (input, options = {}) => {
    // The check follows both the execution that calls it and the caller's signal, and owns a lifetime only when
    // neither alone covers it. Its port calls follow the same signal.
    const ambient = uow?.executionSignal;
    const supplied = options.signal;
    let lifetime: ExecutionLifetime | undefined;
    let signal: AbortSignal;
    if (supplied === undefined || supplied === ambient) {
      if (ambient === undefined) {
        lifetime = executionLifetime(environment?.signal);
        signal = lifetime.signal;
      } else {
        signal = ambient;
      }
    } else if (ambient === undefined) {
      signal = supplied;
    } else {
      lifetime = executionLifetime(ambient, supplied);
      signal = lifetime.signal;
    }
    try {
      const execute = async () =>
        protectAsync(
          async () => {
            if (signal.aborted) {
              return failure(InputCancelledError(signal.reason));
            }
            const ctx = Object.freeze({
              ...dependencies,
              signal,
              actor: environment?.execution.actor,
            });
            return await definition[GuardRun](input as never, ctx as never);
          },
          (error) => executionError(error, signal),
          requireGuardOutcome,
        );
      const run =
        uow === undefined
          ? execute
          : () =>
              uow.withExecution({ signal, actor: environment?.execution.actor, propagation: uow.propagation }, execute);
      return await (environment?.trace({ kind: "guard", reference: definition }, run) ?? run());
    } finally {
      lifetime?.end();
    }
  };
}
