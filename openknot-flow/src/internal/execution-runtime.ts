import { InputCancelledError } from "../errors.ts";
import type { ExecutionIdentity, ExecutionOptions } from "../execution.ts";
import type { ExecutionLifetime } from "./cancellation.ts";
import { executionLifetime } from "./cancellation.ts";
import { observeExecution } from "./execution-logs.ts";
import { executionError } from "./safety.ts";
import type { ExecutionTrace } from "./tracing.ts";
import type { UnitOfWorkExecutor } from "./uow-runtime.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { failure } from "@openknot-ts/behavior";
import { protectAsync, requireOutcome } from "@openknot-ts/behavior/internal/safety";
import type { PropagationCarrier, TraceAttributes } from "@openknot-ts/tracing";

export function executionIdentity(actor: ExecutionOptions["actor"] = undefined): ExecutionIdentity {
  return Object.freeze({ actor });
}

/** What one execution scope knows about the request it serves. */
export interface ExecutionFrame {
  execution: ExecutionIdentity | undefined;
  readonly scopeSignal: AbortSignal | undefined;
  propagation: PropagationCarrier | undefined;
  readonly attributes: TraceAttributes | undefined;
}

/**
 * One application's execution environment. Every scope a Flow host opens enters a frame of its own, which the
 * environment reads through the Unit of Work executor's async context, so definitions that use it are built once
 * instead of in every scope.
 * Work that runs outside such a scope, as a handler resolved through a plain Wire scope does, gets a frame of its
 * own for each root execution.
 */
export function createExecutionEnvironment(uow: UnitOfWorkExecutor) {
  const { tracing, logs } = uow;
  return {
    uow,
    tracing,
    /**
     * Runs a scope's work in its own frame; the scope's host has taken frozen copies of the caller's metadata. A
     * scope whose signal ends once its root execution completes enters as that execution, which adopts the signal.
     */
    enter<T>(options: ExecutionOptions, metadata: ExecutionIdentity, bounded: boolean, work: () => T): T {
      const frame: ExecutionFrame = {
        execution: metadata,
        scopeSignal: options.signal,
        propagation: options.propagation,
        attributes: options.traceAttributes,
      };
      const root =
        bounded && options.signal !== undefined
          ? { signal: options.signal, actor: metadata.actor, propagation: options.propagation }
          : undefined;
      return uow.enter(frame, root, work);
    },
    get execution(): ExecutionIdentity {
      const frame = uow.frame;
      return frame === undefined ? executionIdentity() : (frame.execution ??= executionIdentity());
    },
    get signal(): AbortSignal | undefined {
      return uow.frame?.scopeSignal;
    },
    get propagation(): PropagationCarrier | undefined {
      return uow.frame?.propagation;
    },
    trace<T>(operation: Pick<ExecutionTrace, "kind" | "reference">, work: () => Promise<T>): Promise<T> {
      return observeExecution(tracing, logs, operation, work);
    },
    async run<A>(
      options: ExecutionOptions,
      work: (signal: AbortSignal, metadata: ExecutionIdentity) => PromiseLike<Outcome<A, Error>> | Outcome<A, Error>,
      operation?: Pick<ExecutionTrace, "kind" | "reference">,
    ): Promise<Outcome<A, Error>> {
      const frame: ExecutionFrame = uow.frame ?? {
        execution: undefined,
        scopeSignal: undefined,
        propagation: undefined,
        attributes: undefined,
      };
      let lifetime: ExecutionLifetime | undefined;
      let signal: AbortSignal | undefined;
      try {
        return await protectAsync(
          () => {
            // A root execution owns a lifetime that follows its scope. Nested work shares the signal of the
            // execution that calls it, which already follows that scope, unless the caller passes a signal of its
            // own. Work started while a Unit of Work settles, such as by an effect, owns a lifetime that follows
            // that work's settled signal instead. Building it inside the boundary turns an invalid caller signal into
            // an Outcome as well. A scope that entered as its root execution has lent it the scope's signal.
            const root = uow.activeSignal ?? (uow.settling ? undefined : uow.executionSignal);
            if (root !== undefined && options.signal === undefined) {
              signal = root;
            } else {
              lifetime = executionLifetime(uow.executionSignal ?? frame.scopeSignal, options.signal);
              signal = lifetime.signal;
            }
            const active = signal;
            if (active.aborted) {
              return failure(InputCancelledError(active.reason));
            }
            if (frame.execution === undefined) {
              frame.propagation =
                options.propagation === undefined ? undefined : Object.freeze({ ...options.propagation });
            }
            const metadata = (frame.execution ??= executionIdentity(options.actor));
            const propagation = frame.propagation;
            // Work outside a scope's frame, as a handler called directly, enters the frame it owns.
            const execute = async () =>
              uow.withExecution(
                { signal: active, actor: metadata.actor, propagation },
                () => work(active, metadata),
                frame,
              );
            if (operation === undefined) {
              return execute();
            }
            const input =
              operation.kind === "expose" ||
              operation.kind === "listener" ||
              operation.kind === "scheduler" ||
              operation.kind === "subscribe";
            return observeExecution(
              tracing,
              logs,
              {
                ...operation,
                propagation: input ? propagation : options.propagation,
                attributes: input ? frame.attributes : options.traceAttributes,
              },
              execute,
            );
          },
          (error) => executionError(error, signal),
          (value) => requireOutcome(value, "Handler run() must return an Outcome"),
        );
      } finally {
        lifetime?.end();
      }
    },
  };
}

export type ExecutionEnvironment = ReturnType<typeof createExecutionEnvironment>;
