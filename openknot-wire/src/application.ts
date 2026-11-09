import type { DefinitionAdapterContext } from "./adapters.ts";
import type { Environment } from "./config.ts";
import { isConfig, readConfig } from "./config.ts";
import type {
  ApplicationCheck,
  ApplicationDefinition,
  ApplicationStatus,
  OverrideTargets,
  ValueOverride,
} from "./definition.ts";
import { applicationStatus } from "./definition.ts";
import { isOptionalDependency } from "./dependencies.ts";
import type { Acquisition, Cleanup } from "./internal/acquisition.ts";
import { checkMethod, initializeResources, step, throwWithCleanup } from "./internal/acquisition.ts";
import { composeApplication, invalidDependencies, unavailable } from "./internal/composition.ts";
import type { ResolutionScope } from "./internal/container.ts";
import { createRootScope } from "./internal/container.ts";
import type { AcquisitionStep } from "./internal/plans.ts";
import { onProcessSignal } from "./internal/process-signals.ts";
import { createRegistrations } from "./internal/registrations.ts";
import type { AnyProvider, ApplicationHook, Definition, Provider, Requirement, Resolved } from "./providers.ts";

/** Process signals that stopOn can bind. */
export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGUSR2";

/** Ctrl+C in a terminal and the termination request of process managers and containers. */
const defaultStopSignals: readonly ShutdownSignal[] = Object.freeze(["SIGINT", "SIGTERM"]);

export interface RunApplicationOptions {
  readonly overrides?: readonly ValueOverride[];
  /** Bounds the application's lifetime: aborting cancels startup, or stops the application once it is ready. */
  readonly signal?: AbortSignal;
  /**
   * Process signals that end the application, bound before any resource starts: during startup they unwind it,
   * afterwards they stop it. Defaults to SIGINT and SIGTERM; pass [] when the host handles signals itself.
   * A repeated signal falls back to the platform default. Bound only for this run.
   */
  readonly stopOn?: readonly ShutdownSignal[];
  /** The environment configs read; defaults to process.env. */
  readonly env?: Environment;
}

/**
 * A scope acquires every scoped resource the application reaches, its own `resources`, or what the `root` it
 * executes may need; it names at most one of them.
 */
export type ExecutionScopeOptions = {
  /** Cancels the acquisition of this scope's resources; the scope then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
} & (
  | {
      /** This scope's own scoped resources instead of the default ones, with the scoped resources they depend on. */
      readonly resources?: readonly AnyProvider[];
      readonly root?: never;
    }
  | {
      /**
       * The definition this scope executes, such as an input port: the scope acquires only the scoped resources
       * it may need, through any of its branches, instead of every scoped resource the application reaches.
       */
      readonly root?: Definition;
      readonly resources?: never;
    }
);

export interface ExecutionScope {
  resolve<P extends Requirement>(provider: P): Resolved<P>;
}

export interface Application extends ExecutionScope {
  readonly status: ApplicationStatus;
  readonly ready: boolean;
  withScope<T>(work: (scope: ExecutionScope) => T | Promise<T>, options?: ExecutionScopeOptions): Promise<T>;
  stop(): Promise<void>;
  /** Settles once the application has stopped, whatever stopped it; the same promise stop() returns. */
  readonly stopped: Promise<void>;
}

async function release(stack: Cleanup[], errors: unknown[]): Promise<void> {
  while (stack.length > 0) {
    const cleanup = stack.pop();
    try {
      await cleanup?.();
    } catch (error) {
      errors.push(error);
    }
  }
}

/** Rethrows an operation's own failure together with its cleanup failures, or the cleanup failures alone. */
function settle(cleanupErrors: readonly unknown[], message: string, failure?: { readonly error: unknown }): void {
  if (failure !== undefined) {
    throwWithCleanup(failure.error, cleanupErrors);
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, message);
  }
}

/** When a scope may open besides a ready application: for adapters while the intake is open, and while draining. */
interface ScopeAdmission {
  readonly whileIntakeOpen?: boolean;
  readonly duringShutdown?: boolean;
}

export async function runApplication<
  const D extends ApplicationDefinition,
  const O extends readonly ValueOverride[] = readonly [],
>(
  definition: D & ApplicationCheck<NoInfer<D>, OverrideTargets<NoInfer<O>>>,
  runOptions: RunApplicationOptions & { readonly overrides?: O } = {},
): Promise<Application> {
  const signal = runOptions.signal;
  signal?.throwIfAborted();

  const host = globalThis.process;
  const hosted = typeof host?.once === "function";

  if (runOptions.stopOn !== undefined && runOptions.stopOn.length > 0 && !hosted) {
    throw new TypeError("stopOn requires a Node.js-compatible process.");
  }

  // Without a process the default has nothing to bind; explicit signals were rejected above.
  const stopOn = hosted ? [...new Set(runOptions.stopOn ?? defaultStopSignals)] : [];

  let status: ApplicationStatus = "starting";
  let intakeOpen = false;
  const stoppingController = new AbortController();

  const context: DefinitionAdapterContext = Object.freeze({
    get status(): ApplicationStatus {
      return status;
    },
    stopping: stoppingController.signal,
    get intakeOpen(): boolean {
      return intakeOpen;
    },
    withScope<T>(
      work: (scope: ExecutionScope) => T | Promise<T>,
      options?: ExecutionScopeOptions & { readonly cleanup?: boolean },
    ): Promise<T> {
      return runInScope(work, options, { whileIntakeOpen: true, duringShutdown: options?.cleanup ?? false });
    },
  });

  const composed = await composeApplication(definition, runOptions.overrides ?? [], context, signal);

  if (composed.problems.length > 0) {
    throw invalidDependencies(composed.problems, composed.unbound);
  }

  // Configuration is read once, before any resource, and every invalid variable is reported together.
  const environment: Environment = runOptions.env ?? host?.env ?? {};
  const readings = await Promise.all(composed.configs.map((definition) => readConfig(definition, environment)));
  const invalidConfiguration = readings.flatMap((reading) => reading.problems);

  if (invalidConfiguration.length > 0) {
    throw new Error(`Invalid configuration:\n${invalidConfiguration.join("\n")}`);
  }

  const configValues = new Map<object, object>(
    composed.configs.map((definition, index) => [definition, (readings[index] as { readonly values: object }).values]),
  );

  const {
    keys,
    keyFor,
    providers,
    optionalIdentity,
    lifecycleList,
    scopeAcquisitionPlan,
    rootAcquisitionPlan,
    resources,
    scopeResources,
    startupTasks,
    shutdownTasks,
    intake,
    startupSingletons,
    intakeSingletons,
  } = composed;

  const statusIdentity = keys.get(applicationStatus);
  const currentStatus = (): ApplicationStatus => status;

  /** A value the run itself supplies: the application's live status and each config's variables. */
  function supplied(identity: object): (() => unknown) | undefined {
    if (identity === statusIdentity) {
      return () => currentStatus;
    }
    if (!isConfig(identity)) {
      return undefined;
    }
    // Startup read every config in the graph; an overridden one is supplied by its override instead.
    return () => configValues.get(identity);
  }

  const { registrations, registrationFor } = createRegistrations(composed, supplied);

  const root = createRootScope(registrations, unavailable);
  let stopping = false;
  const stopped = Promise.withResolvers<void>();
  // The run's signal and process signals cancel a startup in progress, or stop a ready application.
  const startup = new AbortController();

  function cancel(reason: unknown): void {
    if (status === "ready") {
      void app.stop();
    } else {
      startup.abort(reason);
    }
  }

  const onAbort = (): void => cancel(signal?.reason);
  const unbindProcessSignals: (() => void)[] = [];
  const resourceCleanup: Cleanup[] = [];
  const intakeCleanup: Cleanup[] = [];
  let tasksReady = false;
  const activeScopes = new Set<Promise<unknown>>();
  let scopesDrained = false;

  /** A plan's steps with their registrations: computed once for the application's own plans. */
  function acquisitionsOf(plan: readonly AcquisitionStep[]): readonly Acquisition[] {
    return plan.map((step) => ({
      ...step,
      registration: registrationFor(step.key, providers.get(step.key) as AnyProvider),
    }));
  }

  const scopeAcquisitions = acquisitionsOf(scopeResources);
  /** Each execution root's plan, computed on its first scope; the application keeps plans, never instances. */
  const rootAcquisitions = new Map<object, readonly Acquisition[]>();

  function acquisitionsFor(scopeOptions: ExecutionScopeOptions): readonly Acquisition[] {
    const { resources: listed, root: executed } = scopeOptions;
    if (listed !== undefined && executed !== undefined) {
      throw new TypeError("withScope() accepts either its own resources or the root it executes, not both.");
    }

    if (listed !== undefined) {
      const references = lifecycleList("withScope({ resources })", listed, "resource", "scoped", (problem) => {
        throw new Error(problem);
      });
      return acquisitionsOf(scopeAcquisitionPlan(references));
    }

    if (executed === undefined) {
      return scopeAcquisitions;
    }

    const key = keyFor(executed);
    let plan = rootAcquisitions.get(key);

    if (plan === undefined) {
      plan = acquisitionsOf(rootAcquisitionPlan(executed));
      rootAcquisitions.set(key, plan);
    }

    return plan;
  }

  function resolveFrom<P extends Requirement>(scope: ResolutionScope, provider: P): Resolved<P> {
    const reference = isOptionalDependency(provider) ? provider.reference : provider;
    const selected = isOptionalDependency(provider) ? optionalIdentity(provider.reference) : keys.get(reference);

    if (selected === undefined && isOptionalDependency(provider)) {
      return undefined as Resolved<P>;
    }

    // The reference ties the public result type to the canonical registration.
    return scope.resolve(selected ?? keyFor(reference)) as Resolved<P>;
  }

  async function closeApplication(): Promise<void> {
    signal?.removeEventListener("abort", onAbort);

    for (const unbind of unbindProcessSignals.splice(0)) {
      unbind();
    }

    const errors: unknown[] = [];

    if (tasksReady) {
      // Shutdown runs to completion: its tasks receive a signal that never aborts.
      const completion = new AbortController().signal;
      for (const provider of shutdownTasks) {
        try {
          await runHook(provider, completion);
        } catch (error) {
          errors.push(error);
        }
      }
    }

    await release(intakeCleanup, errors);
    intakeOpen = false;

    // A draining scope may open a cleanup scope, which is drained as well; none opens after the last one.
    while (activeScopes.size > 0) {
      for (const result of await Promise.allSettled(activeScopes)) {
        if (result.status === "rejected") {
          errors.push(result.reason);
        }
      }
    }
    scopesDrained = true;

    root.release();
    await release(resourceCleanup, errors);

    status = "stopped";
    settle(errors, "Application shutdown failed.");
  }

  async function runHook(provider: Provider<ApplicationHook, never, "hook">, signal: AbortSignal): Promise<void> {
    const key = keyFor(provider);
    const task = resolveFrom(root, provider);
    checkMethod(task, "run", key);
    await step(signal, async () => task.run({ signal }));
  }

  function runInScope<T>(
    work: (scope: ExecutionScope) => T | Promise<T>,
    scopeOptions: ExecutionScopeOptions = {},
    admission: ScopeAdmission = {},
  ): Promise<T> {
    if (
      status !== "ready" &&
      !(admission.whileIntakeOpen && intakeOpen) &&
      !(admission.duringShutdown && status === "stopping" && !scopesDrained)
    ) {
      return Promise.reject(new Error(`Cannot open a scope while application is '${status}'.`));
    }

    const operation: Promise<T> = Promise.resolve().then(async (): Promise<T> => {
      try {
        const resolution = root.createScope();
        const cleanup: Cleanup[] = [];
        let open = true;

        const scope: ExecutionScope = Object.freeze({
          resolve<P extends Requirement>(provider: P): Resolved<P> {
            if (!open) {
              throw new Error("Execution scope is closed.");
            }
            return resolveFrom(resolution, provider);
          },
        });

        let value: T | undefined;
        let failed = false;
        let workError: unknown;

        try {
          // A scope with nothing to acquire or release adds no steps of its own around its work: awaiting both empty
          // steps would add about a third to an empty scope's time.
          const acquisitions = acquisitionsFor(scopeOptions);
          if (acquisitions.length > 0) {
            await initializeResources(acquisitions, resolution, cleanup, scopeOptions.signal);
          } else {
            scopeOptions.signal?.throwIfAborted();
          }
          value = await work(scope);
        } catch (error) {
          failed = true;
          workError = error;
        } finally {
          open = false;
        }

        const errors: unknown[] = [];

        resolution.release();
        if (cleanup.length > 0) {
          await release(cleanup, errors);
        }

        settle(errors, "Scope cleanup failed.", failed ? { error: workError } : undefined);
        return value as T;
      } finally {
        activeScopes.delete(operation);
      }
    });

    activeScopes.add(operation);
    return operation;
  }

  const app: Application = Object.freeze({
    get status(): ApplicationStatus {
      return status;
    },
    get ready(): boolean {
      return status === "ready";
    },
    resolve<P extends Requirement>(provider: P): Resolved<P> {
      if (status !== "ready") {
        throw new Error(`Cannot resolve providers while application is '${status}'.`);
      }
      // The root scope itself rejects scoped values, also those a transient reaches.
      return resolveFrom(root, provider);
    },
    withScope<T>(work: (scope: ExecutionScope) => T | Promise<T>, options?: ExecutionScopeOptions): Promise<T> {
      return runInScope(work, options);
    },
    stop(): Promise<void> {
      if (!stopping) {
        stopping = true;
        status = "stopping";
        stoppingController.abort(new DOMException("The application is stopping.", "AbortError"));
        Promise.resolve().then(closeApplication).then(stopped.resolve, stopped.reject);
      }
      return stopped.promise;
    },
    stopped: stopped.promise,
  });

  if (host !== undefined) {
    for (const name of stopOn) {
      unbindProcessSignals.push(onProcessSignal(host, name, () => cancel(new Error(`Received ${name}.`))));
    }
  }

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // An abort before the listener was attached; afterwards the startup signal follows the run's signal.
    signal?.throwIfAborted();

    await initializeResources(acquisitionsOf(resources), root, resourceCleanup, startup.signal);

    for (const identity of startupSingletons) {
      root.resolve(identity);
    }

    intakeOpen = true;

    await initializeResources(acquisitionsOf(intake), root, intakeCleanup, startup.signal);

    for (const identity of intakeSingletons) {
      root.resolve(identity);
    }

    tasksReady = true;

    for (const provider of startupTasks) {
      await runHook(provider, startup.signal);
    }

    startup.signal.throwIfAborted();

    status = "ready";

    return app;
  } catch (error) {
    const errors: unknown[] = [];

    try {
      await app.stop();
    } catch (cleanupError) {
      if (cleanupError instanceof AggregateError) {
        errors.push(...cleanupError.errors);
      } else {
        errors.push(cleanupError);
      }
    }

    throwWithCleanup(error, errors);
  }
}
