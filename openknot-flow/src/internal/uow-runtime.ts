import { InputCancelledError, InternalFlowError, PostCommitError, UnitOfWorkError } from "../errors.ts";
import type { ExecutionIdentity } from "../execution.ts";
import type { HookExecutionContext, ResolvedHook } from "../hook.ts";
import type {
  CommitContext,
  UnitOfWorkContext,
  UnitOfWorkDefinition,
  UnitOfWorkEffect,
  UnitOfWorkImplementation,
  UnitOfWorkMode,
  UowCompleted,
  UowHooks,
} from "../unit-of-work.ts";
import type { ExecutionLifetime } from "./cancellation.ts";
import { executionLifetime } from "./cancellation.ts";
import type { ExecutionFrame } from "./execution-runtime.ts";
import { createJournal } from "./journal.ts";
import type { Journal } from "./journal.ts";
import { executionError, plugFailure, requireVoidOutcome } from "./safety.ts";
import { traceExecution } from "./tracing.ts";
import type { CommitListener, CommittedChange } from "./wire/changes.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { failure, InternalBehaviorError } from "@openknot-ts/behavior";
import { isCancellation, protectAsync, requireOutcome } from "@openknot-ts/behavior/internal/safety";
import type { PropagationCarrier, Tracing } from "@openknot-ts/tracing";
import { bindTrace } from "@openknot-ts/tracing";
import { isThenable } from "@openknot-ts/wire/internal/synchronous";
import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionState extends HookExecutionContext {
  readonly propagation?: PropagationCarrier | undefined;
}

export interface RuntimeUnitOfWork {
  readonly kind: "unit-of-work";
  readonly reference: UnitOfWorkDefinition;
  readonly implementation: UnitOfWorkImplementation;
  readonly hooks: Readonly<Partial<Record<keyof UowHooks, readonly ResolvedHook<never>[]>>>;
}

type Phase = "run" | "beforeCommit" | "afterCommit" | "effects" | "publications" | "cleanup" | "complete";

const withoutReceipts: CommitContext = Object.freeze({
  latest(): never {
    throw UnitOfWorkError("latest() requires a persistence receipt from this Unit of Work");
  },
});

interface Work {
  readonly driver: RuntimeUnitOfWork;
  readonly mode: UnitOfWorkMode;
  readonly context: ExecutionState;
  readonly effects: UnitOfWorkEffect[];
  readonly publications: UnitOfWorkEffect[];
  /** Staged publications of transactional implementations, sent at the end of beforeCommit. */
  readonly transactional: UnitOfWorkEffect[];
  journal: Journal | undefined;
  readonly completions: ((committed: boolean) => void)[];
  readonly token: object;
  phase: Phase;
  committed: boolean;
  failed: Error | undefined;
  /** An authored beforeCommit failure; it becomes the Unit of Work's own failure once the rollback is confirmed. */
  vetoed: Error | undefined;
}

/** What a Unit of Work's effects and publications read: its receipts, or none when it wrote nothing. */
function committedOf(work: Work): CommitContext {
  return work.journal?.committed ?? withoutReceipts;
}

/**
 * Everything an execution reads from async context, as one immutable value: its scope's frame, the Unit of Work it
 * runs in and its own signal, actor and propagation. Changing any of them enters one new context.
 */
interface ExecutionContext {
  readonly frame?: ExecutionFrame | undefined;
  readonly work?: Work | undefined;
  readonly execution?: ExecutionState | undefined;
}

/** A beforeCommit hook's internal failure and this execution's own cancellation keep their classification. */
function ownFailure(error: Error, signal: AbortSignal): boolean {
  return (
    InternalFlowError.is(error) || InternalBehaviorError.is(error) || (InputCancelledError.is(error) && signal.aborted)
  );
}

/** Application-local async carrier. Every native input starts an isolated execution. */
export function createUnitOfWorkExecutor(tracing?: Tracing) {
  const contexts = new AsyncLocalStorage<ExecutionContext>();
  const currentWork = (): Work | undefined => contexts.getStore()?.work;
  const currentExecution = (): ExecutionState | undefined => contexts.getStore()?.execution;
  const listeners = new Set<CommitListener>();

  const record = (identity: Parameters<CommitListener["recorded"]>[0]) => {
    for (const listener of listeners) {
      listener.recorded(identity);
    }
  };

  /** A Unit of Work keeps a journal only once it writes or a publication reads its receipts. */
  const journalOf = (work: Work): Journal => (work.journal ??= createJournal(record));

  /** Ends what a Unit of Work started for the read layers; returns their failures. */
  function settleListeners(
    journal: Journal | undefined,
    completions: readonly ((committed: boolean) => void)[],
    committed: boolean,
  ): unknown[] {
    const errors: unknown[] = [];

    for (const completion of completions) {
      try {
        completion(committed);
      } catch (error) {
        errors.push(error);
      }
    }

    if (journal === undefined) {
      return errors;
    }

    errors.push(...journal.recordFailures);

    if (listeners.size === 0) {
      return errors;
    }

    const identities = journal.identities();

    if (identities.length === 0) {
      return errors;
    }

    for (const listener of listeners) {
      try {
        listener.settled(identities);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  /** Delivers committed changes to every listener and returns their failures; one failure does not stop the others. */
  async function deliver(changes: readonly CommittedChange[]): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (changes.length === 0) {
      return errors;
    }
    for (const listener of listeners) {
      try {
        await listener.committed(changes);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  function active(): Work | undefined {
    const current = currentWork();
    return current?.phase === "run" || current?.phase === "beforeCommit" ? current : undefined;
  }

  /** Effects and publications are staged until the effects phase ends. */
  function stages(work: Work | undefined): work is Work {
    return (
      work?.phase === "run" ||
      work?.phase === "beforeCommit" ||
      work?.phase === "afterCommit" ||
      work?.phase === "effects"
    );
  }

  function defers(work: Work | undefined, immediate: boolean): work is Work {
    return !immediate && stages(work);
  }

  function context(work: Work): UnitOfWorkContext {
    return Object.freeze({
      mode: work.mode,
      actor: work.context.actor,
      afterCommit(effect: UnitOfWorkEffect) {
        if (!stages(work)) {
          throw UnitOfWorkError("Effects can only be staged before publications begin");
        }
        if (typeof effect !== "function") {
          throw new TypeError("afterCommit() requires a function");
        }
        work.effects.push(
          bindTrace(tracing, async () => {
            await effect(committedOf(work));
          }),
        );
      },
    });
  }

  /**
   * Runs a phase's hooks in registration order and returns their failures: a deciding phase stops at the first,
   * or once nested work has failed the Unit of Work, while a cleanup phase runs every hook. An overridden hook
   * bypasses its executor, so each call is protected here.
   */
  async function hooks(
    work: Work,
    phase: keyof UowHooks,
    event: object,
    state: ExecutionState,
    cleanup = false,
  ): Promise<Error[]> {
    Object.freeze(event);
    const failures: Error[] = [];
    for (const item of work.driver.hooks[phase] ?? []) {
      const result = await protectAsync(
        () => item(event as never, state),
        (error) => executionError(error, state.signal),
        (value) => requireVoidOutcome(value, "Hook run() must return a void Outcome"),
      );
      if (result.isError) {
        failures.push(result.error);
      }
      if (!cleanup && (result.isError || work.failed !== undefined)) {
        break;
      }
    }
    return failures;
  }

  /**
   * One execution within a Unit of Work, the root's or a nested one: its Outcome, its thrown failure, or its own
   * cancellation, which fails it even when it returned a success.
   */
  async function attempt<T>(
    run: (uow: UnitOfWorkContext) => Promise<Outcome<T, Error>>,
    uow: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Outcome<T, Error>> {
    try {
      const result = await run(uow);
      requireOutcome(result, "Handler run() must return an Outcome");
      return !result.isError && signal.aborted ? failure(InputCancelledError(signal.reason)) : result;
    } catch (error) {
      return failure(executionError(error, signal));
    }
  }

  async function root<T>(
    work: Work,
    run: (uow: UnitOfWorkContext) => Promise<Outcome<T, Error>>,
  ): Promise<Outcome<T, Error>> {
    let result: Outcome<T, Error> | undefined;
    // What the work returned to the driver, and the errors the executor throws through it; recognised by identity.
    let produced: Outcome<T, Error> | undefined;
    let rollback: Error | undefined;
    let violation: Error | undefined;
    let entered = false;
    let status: UowCompleted["status"] = "unknown";
    let settled: ExecutionLifetime | undefined;

    const violated = (message: string): Error =>
      (violation = UnitOfWorkError(message, {
        ...(work.failed === undefined ? {} : { cause: work.failed }),
        transactionStatus: "unknown",
      }));

    /**
     * Runs work after the transaction ended. Nothing interrupts it: it and the executions it starts follow a signal
     * that only the Unit of Work's completion ends, never the caller's. Created only when such work exists.
     */
    const afterTransaction = <R>(run: (state: ExecutionState) => Promise<R>): Promise<R> => {
      settled ??= executionLifetime();
      const state: ExecutionState = Object.freeze({ ...work.context, signal: settled.signal });
      return contexts.run({ ...contexts.getStore(), execution: state }, () => run(state));
    };

    const hasHooks = (phase: keyof UowHooks): boolean => (work.driver.hooks[phase]?.length ?? 0) > 0;

    try {
      try {
        const returned = await work.driver.implementation.transaction(
          async () => {
            if (entered) {
              throw violated("A transaction driver must invoke work exactly once");
            }

            entered = true;

            const signal = work.context.signal;
            const outcome = await attempt(run, context(work), signal);

            if (outcome.isError) {
              work.failed ??= outcome.error;
            }

            // Writes still running settle before the next phase; a failed one fails the work.
            const settleWrites = async () => {
              const inflight = work.journal?.inflight;
              while (inflight !== undefined && inflight.size > 0) {
                await Promise.allSettled(inflight);
              }
              if (work.failed === undefined && work.journal !== undefined && work.journal.failures.length > 0) {
                work.failed = executionError(plugFailure(work.journal.failures[0], signal), signal);
              }
            };

            await settleWrites();

            work.phase = "beforeCommit";

            if (work.failed === undefined && hasHooks("beforeCommit")) {
              const [vetoed] = await hooks(work, "beforeCommit", { status: "active", mode: work.mode }, work.context);
              // A failure nested work recorded meanwhile comes first; any other failure a hook reports vetoes.
              if (vetoed !== undefined && work.failed === undefined) {
                work.failed = vetoed;
                if (!ownFailure(vetoed, signal)) {
                  work.vetoed = vetoed;
                }
              }
            }

            // Transactional publications are stored with the change: sent last, after the hooks that may add to them.
            while (work.failed === undefined && work.transactional.length > 0) {
              const send = work.transactional.shift()!;
              try {
                await send(committedOf(work));
              } catch (error) {
                work.failed ??= executionError(error, signal);
              }
            }

            // The hooks and transactional sends may have started writes of their own.
            await settleWrites();

            if (signal.aborted) {
              work.failed ??= InputCancelledError(signal.reason);
            }

            if (work.failed !== undefined) {
              rollback = new Error("Unit of Work rollback");
              throw rollback;
            }

            return (produced = outcome);
          },
          { ...work.context, mode: work.mode },
        );

        if (!entered || rollback !== undefined || produced === undefined || returned !== produced) {
          throw violated("A transaction driver must propagate work failure and return its successful result");
        }

        result = produced;
        work.committed = true;
        status = "committed";
      } catch (error) {
        // A driver cancelled before it entered the work ran none of it: the caller's cancellation is the failure.
        // Any other native failure leaves the outcome unknown, as a broken driver contract already reports; a failure
        // of the work itself stays in its cause.
        const cause =
          error === rollback
            ? work.vetoed === undefined
              ? work.failed!
              : UnitOfWorkError("beforeCommit hook failed", { cause: work.vetoed, transactionStatus: "rolled-back" })
            : !entered && isCancellation(error, work.context.signal)
              ? InputCancelledError(work.context.signal.reason)
              : violation !== undefined && error === violation
                ? violation
                : UnitOfWorkError("Native transaction outcome is unknown", {
                    cause:
                      work.failed === undefined
                        ? error
                        : new AggregateError(
                            [work.failed, error],
                            "Work failed and its transaction outcome is unknown",
                          ),
                    transactionStatus: "unknown",
                  });

        status = error === rollback ? "rolled-back" : "unknown";
        result = failure(cause);
      }

      if (work.committed) {
        work.phase = "afterCommit";

        if (
          hasHooks("afterCommit") ||
          work.effects.length > 0 ||
          work.publications.length > 0 ||
          ((work.journal?.entries.size ?? 0) > 0 && listeners.size > 0) ||
          work.completions.length > 0
        ) {
          // Committed work runs to completion: a failing hook or effect does not stop the others, and the staged
          // publications are still delivered, in order, up to the first that fails.
          await afterTransaction(async (state) => {
            const failures: unknown[] = await hooks(work, "afterCommit", { status, mode: work.mode }, state, true);
            const hooksFailed = failures.length > 0;
            const listenerFailures =
              work.journal !== undefined && listeners.size > 0 ? await deliver(work.journal.changes()) : [];

            for (const completion of work.completions.splice(0)) {
              try {
                completion(true);
              } catch (error) {
                listenerFailures.push(error);
              }
            }

            const listenersFailed = listenerFailures.length > 0;
            failures.push(...listenerFailures);
            work.phase = "effects";

            for (const effect of work.effects) {
              try {
                await effect(committedOf(work));
              } catch (error) {
                failures.push(error);
              }
            }

            const effectsFailed = failures.length > 0;
            work.phase = "publications";

            for (const publish of work.publications) {
              try {
                await publish(committedOf(work));
              } catch (error) {
                failures.push(error);
                break;
              }
            }

            if (failures.length > 0) {
              result = failure(
                PostCommitError(
                  hooksFailed ? "effects" : listenersFailed ? "changes" : effectsFailed ? "effects" : "publications",
                  failures.length === 1
                    ? failures[0]
                    : new AggregateError(failures, "Committed work's follow-up failed"),
                ),
              );
            }
          });
        }
      } else {
        // The transaction has ended: rollback cleanup is no longer active work, and it publishes nothing.
        work.phase = "cleanup";
        const cause = result!.isError ? result!.error : undefined;

        if (status === "rolled-back" && cause !== undefined && hasHooks("afterRollback")) {
          const failures = await afterTransaction((state) =>
            hooks(work, "afterRollback", { status, mode: work.mode, error: cause }, state, true),
          );

          if (failures.length > 0) {
            result = failure(
              UnitOfWorkError("Rollback hooks failed", {
                cause: new AggregateError([cause, ...failures], "Work and its rollback hooks failed"),
                transactionStatus: "rolled-back",
              }),
            );
          }
        }
      }
    } finally {
      work.phase = "cleanup";
      work.effects.length = 0;
      work.publications.length = 0;
      work.transactional.length = 0;

      /** Joins cleanup failures to the work's own failure, after the commit or as part of the failed work. */
      const cleanupFailed = (phase: "changes" | "completion", message: string, failures: readonly unknown[]): void => {
        const error = result?.isError ? result.error : undefined;
        const cause = new AggregateError(error === undefined ? failures : [error, ...failures], message);

        result = failure(
          work.committed
            ? PostCommitError(phase, cause)
            : UnitOfWorkError(message, {
                cause,
                transactionStatus: status === "rolled-back" ? "rolled-back" : "unknown",
              }),
        );
      };

      const listenerFailures = settleListeners(work.journal, work.completions.splice(0), work.committed);

      if (listenerFailures.length > 0) {
        cleanupFailed("changes", "Unit of Work listeners failed to settle", listenerFailures);
      }

      if (hasHooks("afterCompletion")) {
        const error = result?.isError ? result.error : undefined;
        const completed = { status, mode: work.mode, ...(error === undefined ? {} : { error }) };
        const failures = await afterTransaction((state) => hooks(work, "afterCompletion", completed, state, true));

        if (failures.length > 0) {
          cleanupFailed("completion", "Completion hooks failed", failures);
        }
      }

      work.phase = "complete";
      // Native work the Unit of Work started keeps its async context for as long as it lives, such as a client's
      // command timer: once complete, the Unit of Work leaves it no receipts or failures to keep alive.
      work.journal = undefined;
      work.failed = undefined;
      work.vetoed = undefined;
      settled?.end();
    }

    return result ?? failure(UnitOfWorkError("Transaction completed without an Outcome"));
  }

  return {
    tracing,
    touched(result: unknown): boolean {
      return active()?.journal?.touched(result) ?? false;
    },
    transaction(): object | undefined {
      return active()?.token;
    },
    wrote(entity: string): boolean {
      return active()?.journal?.wrote(entity) ?? false;
    },
    afterCompletion(effect: (committed: boolean) => void): void {
      const work = active();
      if (work === undefined) {
        effect(true);
      } else {
        work.completions.push(effect);
      }
    },
    subscribe(listener: CommitListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get commitContext() {
      const work = currentWork();
      return work === undefined ? undefined : journalOf(work).committed;
    },
    write(run: () => unknown, args: readonly unknown[] = [], writer?: object): unknown {
      const work = active();
      const journal = work === undefined ? undefined : journalOf(work);
      const token = journal?.begin();

      function recorded(result: unknown): unknown {
        if (work === undefined || journal === undefined || token === undefined) {
          const standalone = createJournal(record);
          const standaloneToken = standalone.begin();
          if (!standalone.finish(standaloneToken, result, args, writer)) {
            return result;
          }
          if (listeners.size === 0) {
            return result;
          }
          return deliver(standalone.changes()).then((errors) => {
            errors.push(...settleListeners(standalone, [], true));
            if (errors.length > 0) {
              throw PostCommitError(
                "changes",
                errors.length === 1
                  ? errors[0]
                  : new AggregateError(errors, "Unit of Work listeners failed after the write"),
              );
            }
            return result;
          });
        }
        let managed: boolean;
        try {
          managed = journal.finish(token, result, args, writer);
        } catch (error) {
          work.failed ??= executionError(error, work.context.signal);
          throw error;
        }
        if (managed && work.mode === "read-only") {
          const error = UnitOfWorkError("A read-only Unit of Work cannot persist changes");
          work.failed ??= error;
          throw error;
        }
        return result;
      }

      function failed(error: unknown): never {
        if (token !== undefined) {
          journal!.settle(token);
        }
        if (journal !== undefined && !journal.failures.includes(error)) {
          journal.failures.push(error);
        }
        throw error;
      }

      try {
        const source = run();

        if (isThenable(source)) {
          const promise = Promise.resolve(source).then(recorded).catch(failed);

          if (journal !== undefined) {
            journal.inflight.add(promise);
            void promise.then(
              () => journal.inflight.delete(promise),
              () => journal.inflight.delete(promise),
            );
          }
          return promise;
        }

        return recorded(source);
      } catch (error) {
        return failed(error);
      }
    },
    /** The frame of the scope the current work runs in. */
    get frame(): ExecutionFrame | undefined {
      return contexts.getStore()?.frame;
    },
    /**
     * Enters a scope's frame, as its root execution when the scope's signal is that execution's own. Every native
     * input starts an isolated execution, outside any Unit of Work.
     */
    enter<T>(frame: ExecutionFrame, execution: ExecutionState | undefined, work: () => T): T {
      return contexts.run({ frame, work: undefined, execution }, work);
    },
    /** Runs work as an execution of the given frame, by default the current one. */
    withExecution<T>(state: ExecutionState, work: () => T, entered?: ExecutionFrame): T {
      const context = contexts.getStore();
      const frame = entered ?? context?.frame;
      const running = context?.execution;
      // Nested work that keeps its caller's frame, signal, actor and propagation needs no context of its own.
      if (
        running !== undefined &&
        context!.frame === frame &&
        running.signal === state.signal &&
        running.actor === state.actor &&
        running.propagation === state.propagation
      ) {
        return work();
      }
      return contexts.run({ ...context, frame, execution: state }, work);
    },
    get propagation(): PropagationCarrier | undefined {
      return currentWork()?.context.propagation ?? currentExecution()?.propagation;
    },
    get activeSignal(): AbortSignal | undefined {
      return active()?.context.signal;
    },
    /** Whether the current work runs after its Unit of Work's transaction ended, as effects and hooks do. */
    get settling(): boolean {
      return currentWork() !== undefined && active() === undefined;
    },
    /**
     * The current execution's signal, which its port calls, publications and the executions it starts follow. Work
     * after a transaction ended runs under a signal that only the Unit of Work's completion ends.
     */
    get executionSignal(): AbortSignal | undefined {
      return currentExecution()?.signal;
    },
    defers(immediate: boolean): boolean {
      return defers(currentWork(), immediate);
    },
    fail(error: Error): void {
      const current = active();
      if (current !== undefined) {
        current.failed ??= error;
      }
    },
    async run<T>(
      driver: RuntimeUnitOfWork,
      mode: UnitOfWorkMode,
      execution: ExecutionIdentity,
      signal: AbortSignal,
      run: (uow: UnitOfWorkContext) => Promise<Outcome<T, Error>>,
    ): Promise<Outcome<T, Error>> {
      const parent = active();

      if (parent !== undefined) {
        if (parent.driver.reference !== driver.reference || (parent.mode === "read-only" && mode === "read-write")) {
          parent.failed ??= UnitOfWorkError(
            parent.driver.reference !== driver.reference
              ? "Nested work must use the same resolved Unit of Work"
              : "A read-only Unit of Work cannot execute a command",
          );
          return failure(parent.failed);
        }

        const result = await attempt(run, context(parent), signal);

        if (result.isError) {
          parent.failed ??= result.error;
        }
        return result;
      }

      const work: Work = {
        driver,
        mode,
        context: { actor: execution.actor, signal, propagation: currentExecution()?.propagation },
        effects: [],
        publications: [],
        transactional: [],
        journal: undefined,
        completions: [],
        token: Object.freeze({}),
        phase: "run",
        committed: false,
        failed: undefined,
        vetoed: undefined,
      };

      return traceExecution(tracing, { kind: "unit-of-work", reference: driver.reference }, async () =>
        contexts.run({ ...contexts.getStore(), work }, () => root(work, run)),
      );
    },

    async publish(send: UnitOfWorkEffect, immediate = false, transactional = false): Promise<void> {
      const work = currentWork();

      if (work?.phase === "complete") {
        throw UnitOfWorkError("The Unit of Work is complete");
      }

      // Work that did not commit publishes nothing, from its cleanup or from anything of it still running.
      if (work?.phase === "cleanup" && !work.committed) {
        throw UnitOfWorkError("The Unit of Work did not commit");
      }

      const committed = work === undefined ? undefined : committedOf(work);

      if (transactional && !immediate && work !== undefined && active() === work) {
        work.transactional.push(send);
      } else if (defers(work, immediate)) {
        work.publications.push(send);
      } else {
        await send(committed ?? withoutReceipts);
      }
    },
  };
}
export type UnitOfWorkExecutor = ReturnType<typeof createUnitOfWorkExecutor>;
