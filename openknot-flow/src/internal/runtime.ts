import type {
  InputPortDefinition,
  InputResult,
  ListenerTrigger,
  ListenerRequest,
  SchedulerRequest,
  SkippedInvocation,
} from "../definitions.ts";
import { InputRun } from "../definitions.ts";
import { InputCancelledError, InputUnavailableError } from "../errors.ts";
import type { ExecutionOptions } from "../execution.ts";
import type { ExposureRequest } from "../exposure.ts";
import { isExposure } from "../exposure.ts";
import type { ExecutionLifetime } from "./cancellation.ts";
import { executionLifetime } from "./cancellation.ts";
import { addCheckpoints, portKeys } from "./checkpoint.ts";
import type { ExecutionLogs } from "./execution-logs.ts";
import type { ExecutionEnvironment } from "./execution-runtime.ts";
import type { RuntimeGuard } from "./guard-execution.ts";
import { guardAdmission } from "./guard-execution.ts";
import { observeInput, refuseInput } from "./input-observation.ts";
import { executionOptions, ownField, requireRequest } from "./request.ts";
import { cleanupError, executionError, requireSuccess } from "./safety.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { failure } from "@openknot-ts/behavior";
import { protectAsync, requireOutcome } from "@openknot-ts/behavior/internal/safety";
import type { ErrorReporter } from "@openknot-ts/error-reporting";
import type { Tracing } from "@openknot-ts/tracing";
import type { PlugDefinition, PlugHandle } from "@openknot-ts/wire";

export interface RuntimeScope {
  readonly execution: ExecutionEnvironment;
  resolve(reference: object): unknown;
}

export interface InputHost {
  readonly status: string;
  /** Inputs admit invocations while it holds: hosts and sources drain admitted work as the application stops. */
  readonly intakeOpen: boolean;
  /** Aborts once the application begins stopping. */
  readonly stopping: AbortSignal;
  readonly tracing?: Tracing | undefined;
  readonly logs?: ExecutionLogs | undefined;
  /** Delivers a report to the application's error reporter, when one is bound. */
  readonly report: ErrorReporter;
  /**
   * `root` is the port the scope executes: it acquires only the scoped resources that port may need. `bounded`
   * declares that `signal` aborts once the scope's execution completes, so that execution adopts it.
   */
  withScope<T>(
    work: (scope: RuntimeScope) => T | Promise<T>,
    options?: ExecutionOptions & { readonly cleanup?: boolean; readonly root?: object; readonly bounded?: boolean },
  ): Promise<T>;
}

type InputRequest = ListenerRequest<unknown> | SchedulerRequest | ExposureRequest<unknown>;

/** Resolves with the execution's value, or a skipped scheduler tick, and rejects with its classified failure. */
export type RuntimeInvoke = ((request: InputRequest) => Promise<unknown>) & {
  readonly tracing?: Tracing | undefined;
};

/** A trigger is absent or an object, whose own fields carry its metadata. */
function triggerOf(request: object): object | undefined {
  const trigger = ownField(request, "trigger");
  if (trigger === undefined) {
    return undefined;
  }

  if (typeof trigger !== "object" || trigger === null || Array.isArray(trigger)) {
    throw new TypeError("Invalid trigger");
  }

  return trigger;
}

function deliveryTrigger(trigger: object | undefined): ListenerTrigger {
  const messageId = trigger === undefined ? undefined : ownField(trigger, "messageId");
  const attempt = trigger === undefined ? undefined : ownField(trigger, "attempt");

  if (messageId !== undefined && typeof messageId !== "string") {
    throw new TypeError("Invalid messageId");
  }

  if (attempt !== undefined && (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1)) {
    throw new TypeError("Delivery attempts are one-based positive integers");
  }

  return {
    ...(messageId === undefined ? {} : { messageId }),
    ...(attempt === undefined ? {} : { attempt }),
  };
}

/** An input's own invoker, which can also refuse a request for the source that binds it. */
export type RuntimeEndpoint = RuntimeInvoke & { readonly refuse: (error: Error) => Promise<never> };

/** Holds only definition metadata and an application-local scope capability. */
export function createInputInvoker(port: InputPortDefinition, host: InputHost): RuntimeEndpoint {
  // Startup validation has checked these references; their entries and the port's guards are fixed per port.
  const requirements = Object.entries(port.requirements);
  const admit = isExposure(port) ? guardAdmission(port.guards) : undefined;
  const skipsOverlap = port.kind === "scheduler" && "overlap" in port && port.overlap === "skip";
  const ports = portKeys(port.requirements);
  const operation = { kind: port.kind, reference: port };

  let active = 0;

  const execute = async (request: InputRequest): Promise<Outcome<unknown, Error> | SkippedInvocation> => {
    let lifetime: ExecutionLifetime | undefined;
    let admitted = false;
    let observed = false;
    let signal: AbortSignal | undefined;
    try {
      const result = await protectAsync(
        async () => {
          // A stopping application still admits what its hosts and sources drain, until its intake has closed.
          if (host.status !== "starting" && host.status !== "ready" && !host.intakeOpen) {
            return failure(InputUnavailableError());
          }

          const fields = requireRequest(request);
          const options = executionOptions(fields);

          // The invocation's signal follows the caller's and aborts once the invocation completes.
          lifetime = executionLifetime(options.signal);
          signal = lifetime.signal;

          if (signal.aborted) {
            return failure(InputCancelledError(signal.reason));
          }

          if (skipsOverlap && active > 0) {
            return Object.freeze({ status: "skipped" as const, reason: "overlap" as const });
          }

          active++;
          admitted = true;

          // What the port's kind reads from a request: a scheduler's tick, a listener's delivery, and the input.

          let metadata: object = {};
          let attributes: Readonly<Record<string, string | number>> = {};

          if (port.kind === "scheduler") {
            const tick = triggerOf(fields);
            const scheduledAt = tick === undefined ? undefined : ownField(tick, "scheduledAt");

            // A number a Date cannot represent is no point in time.
            if (typeof scheduledAt !== "number" || Number.isNaN(new Date(scheduledAt).getTime())) {
              throw new TypeError("Invalid scheduledAt");
            }

            metadata = { scheduledAt };
            attributes = { "openknot.scheduler.scheduled_at": new Date(scheduledAt).toISOString() };
          } else if (port.kind === "listener") {
            const delivery = deliveryTrigger(triggerOf(fields));
            metadata = delivery;
            attributes = {
              ...(delivery.messageId === undefined ? {} : { "messaging.message.id": delivery.messageId }),
              ...(delivery.attempt === undefined ? {} : { "openknot.listener.attempt": delivery.attempt }),
            };
          }

          // A scheduler tick carries no input; an absent input, such as a void one, reads as undefined.
          const input = port.kind === "scheduler" ? undefined : ownField(fields, "input");
          const guards = admit?.(fields);
          const executionSignal = signal;
          const traceAttributes = { ...attributes, ...options.traceAttributes };

          // Runs the execution in its scope and classifies it; once it has settled, only the scope's cleanup can fail.
          const settle = async (): Promise<Outcome<unknown, Error>> => {
            let completed: Outcome<unknown, Error> | undefined;
            return protectAsync(
              () =>
                host.withScope(
                  async (scope) => {
                    // The execution's signal follows the invocation's; guards, port calls and run() share it.
                    completed = await scope.execution.run({}, async (active) => {
                      if (guards !== undefined) {
                        const checked = await guards((definition) => scope.resolve(definition) as RuntimeGuard, active);

                        if (checked.isError) {
                          return checked;
                        }

                        if (active.aborted) {
                          return failure(InputCancelledError(active.reason));
                        }
                      }

                      const dependencies: Record<string, unknown> = {};

                      for (const [key, reference] of requirements) {
                        dependencies[key] = scope.resolve(reference);
                      }

                      addCheckpoints(dependencies, ports, scope.execution);

                      const ctx = Object.freeze({
                        ...dependencies,
                        ...(isExposure(port) ? {} : { trigger: Object.freeze(metadata) }),
                        signal: active,
                        actor: scope.execution.execution.actor,
                      });

                      const result: InputResult = port[InputRun](input as never, ctx as never);
                      const outcome = await result;

                      requireOutcome(outcome, "Input run() must return an Outcome");

                      return outcome;
                    });
                    // The execution adopted the invocation's signal; it ends with the execution, before the scope closes.
                    lifetime?.end();

                    return completed;
                  },
                  {
                    signal: executionSignal,
                    ...(options.actor === undefined ? {} : { actor: options.actor }),
                    ...(options.propagation === undefined ? {} : { propagation: options.propagation }),
                    traceAttributes,
                    root: port,
                    bounded: true,
                  },
                ),
              (error) => (completed === undefined ? executionError(error, signal) : cleanupError(completed, error)),
            );
          };

          // From here the execution's own record covers the outcome. Its span also covers the classified result, so
          // the failure is reported while the span is active.
          observed = true;
          return await observeInput(
            host,
            { ...operation, propagation: options.propagation, attributes: traceAttributes },
            settle,
          );
        },
        (error) => executionError(error, signal),
      );
      // A request refused before its execution ran has no record or span of its own.
      if (!observed && "isError" in result && result.isError) {
        refuseInput(host, operation, result.error);
      }
      return result;
    } finally {
      if (admitted) {
        active--;
      }

      lifetime?.end();
    }
  };

  // Every rejection is logged before it is returned, so a source that does not await an invocation cannot leave it
  // unhandled; one that awaits still receives it.
  const handled = <T>(pending: Promise<T>): Promise<T> => {
    pending.catch(() => undefined);
    return pending;
  };
  const refuse = (error: Error): Promise<never> => {
    refuseInput(host, operation, error);
    return handled(Promise.reject(error));
  };

  // The execution stays an Outcome inside Flow; the plug that invokes it receives a value or an exception.
  const invoke = (request: InputRequest): Promise<unknown> =>
    handled(execute(request).then((result) => ("isError" in result ? requireSuccess(result) : result)));

  return Object.freeze(Object.assign(invoke, { tracing: host.tracing, refuse }));
}

/**
 * Binds a selected source for the resource that owns it. The startup's signal also aborts a bind() in progress;
 * afterwards only release() ends the source.
 */
export async function bindInputSource(
  definition: PlugDefinition & { readonly port: InputPortDefinition },
  dependencies: object,
  endpoint: RuntimeEndpoint,
  startup: AbortSignal,
): Promise<{ readonly value: undefined; release(): Promise<void> }> {
  const source = new AbortController();
  const signal = source.signal;
  const cancel = (): void => source.abort(startup.reason);

  startup.addEventListener("abort", cancel, { once: true });

  const invokeFromSource: RuntimeInvoke = Object.freeze(
    Object.assign(
      (request: InputRequest) => (signal.aborted ? endpoint.refuse(InputUnavailableError()) : endpoint(request)),
      { tracing: endpoint.tracing },
    ),
  );

  try {
    const acquired = await definition.bind(
      Object.freeze({
        ...dependencies,
        port: definition.port,
        invoke: invokeFromSource,
        signal,
      }) as never,
    );

    if (
      typeof acquired !== "object" ||
      acquired === null ||
      !("release" in acquired) ||
      typeof acquired.release !== "function"
    ) {
      throw new TypeError("Input plug bind() must return { release() }");
    }

    const handle = acquired as PlugHandle;

    return {
      value: undefined,
      async release() {
        source.abort();
        await handle.release();
      },
    };
  } catch (error) {
    source.abort(error);
    throw error;
  } finally {
    startup.removeEventListener("abort", cancel);
  }
}
