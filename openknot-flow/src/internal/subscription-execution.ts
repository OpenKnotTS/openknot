import { InputCancelledError, InputUnavailableError } from "../errors.ts";
import type { ExecutionOptions } from "../execution.ts";
import type { GuardRequest } from "../guard.ts";
import type { SubscriptionDefinition, NativeSubscription, DeliveryOptions } from "../subscription.ts";
import type { RuntimeGuard } from "./guard-execution.ts";
import { guardAdmission } from "./guard-execution.ts";
import { optionsIndex } from "./publication.ts";
import { executionOptions, ownField, requireRequest } from "./request.ts";
import type { InputHost, RuntimeScope } from "./runtime.ts";
import { cleanupError, executionError, requireSuccess } from "./safety.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { failure, success } from "@openknot-ts/behavior";
import { protectAsync } from "@openknot-ts/behavior/internal/safety";

/**
 * An output plug's binding is resolved in the short-lived scope that owns its dependencies, opened for that plug as its root, so a publication acquires only what
 * delivery needs; admission opens its scope for the port, with its guards.
 */
export interface SubscriptionImplementation {
  readonly root: object;
  readonly resolve: (scope: RuntimeScope) => NativeSubscription;
}

/** Closes a stream no caller received; a native iterable releases its resources on return(). */
function release(stream: AsyncIterable<unknown>): void {
  void Promise.resolve()
    .then(() => stream[Symbol.asyncIterator]().return?.())
    .catch(() => undefined);
}

/** Admission only. Native iterables, buffers and cleanup pass through unchanged. */
export function createSubscriptionPort(
  port: SubscriptionDefinition,
  host: InputHost,
  implementation: SubscriptionImplementation,
) {
  const admit = guardAdmission(port.guards);

  const index = optionsIndex(port);

  return Object.freeze({
    async publish(...args: unknown[]): Promise<void> {
      const options = (args[index] ?? {}) as DeliveryOptions;
      options.signal?.throwIfAborted();

      // The native implementation receives the port's own arguments and the delivery options.
      const forwarded = Array.from({ length: index + 1 }, (_, position) =>
        position === index ? options : args[position],
      ) as never[];

      const deliver = async (native: NativeSubscription) => {
        await native.publish(...forwarded);
      };

      await host.withScope(async (scope) => deliver(implementation.resolve(scope)), {
        ...options,
        cleanup: true,
        root: implementation.root,
      });
    },
    async subscribe(request: GuardRequest<unknown>): Promise<AsyncIterable<unknown>> {
      let options: ExecutionOptions = {};
      let settled: Outcome<AsyncIterable<unknown>, Error> | undefined;

      const result = await protectAsync(
        async () => {
          if (host.status !== "starting" && host.status !== "ready") {
            return failure(InputUnavailableError());
          }

          // Every field is read once, from the request's own fields, before admission runs.
          const fields = requireRequest(request);
          const guards = admit(fields);

          options = executionOptions(fields);

          const input = ownField(fields, "input");

          return host.withScope(
            async (scope) => {
              settled = await scope.execution.run({}, async (signal) => {
                const checked = await guards((reference) => scope.resolve(reference) as RuntimeGuard, signal);
                if (checked.isError) {
                  return checked;
                }
                if (signal.aborted) {
                  return failure(InputCancelledError(signal.reason));
                }
                const native = implementation.resolve(scope);
                // A stream keeps the caller's lifetime, not the short admission scope's signal, and ends once the
                // application begins stopping, so no open stream holds shutdown.
                const lifetime = Object.freeze({
                  ...options,
                  signal:
                    options.signal === undefined ? host.stopping : AbortSignal.any([options.signal, host.stopping]),
                });
                const stream = await native.subscribe(
                  ...((port.kind === "topic" ? [input, lifetime] : [lifetime]) as never[]),
                );
                return success(stream);
              });
              return settled;
            },
            { ...options, root: port },
            { kind: "subscribe", reference: port },
          );
        },
        (error) => {
          if (settled === undefined) {
            return executionError(error, options.signal);
          }

          // Only the admission scope's cleanup failed: no caller receives an admitted stream, so it does not stand.
          if (!settled.isError) {
            release(settled.value);
          }

          return cleanupError(settled, error, false);
        },
      );
      // A transport receives the admitted stream, or the admission's classified failure thrown.
      return requireSuccess(result);
    },
  });
}
