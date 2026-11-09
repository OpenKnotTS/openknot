import type { Requirements } from "../definitions.ts";
import { isPublisher } from "../publisher.ts";
import { isSubscription } from "../subscription.ts";
import { isWriter } from "../writer.ts";
import type { ExecutionEnvironment } from "./execution-runtime.ts";
import type { PublishingPort } from "./publication.ts";
import { scopedPublication } from "./publication.ts";
import { isRecorded } from "./recorded-write.ts";
import { plugFailure } from "./safety.ts";
import { InternalBehaviorError, isOperation, isReader } from "@openknot-ts/behavior";
import { isOptionalDependency } from "@openknot-ts/wire";
import { mapFailure } from "@openknot-ts/wire/internal/synchronous";

type Call = (...args: never[]) => unknown;
type Publishing = { readonly publish: (...args: never[]) => Promise<void> };

/**
 * The requirements where application code leaves its execution, fixed per definition and also when optional:
 * calls to readers, writers and operations, and publications to publishers, topics and broadcasts.
 */
type PortCall =
  | { readonly key: string; readonly kind: "call"; readonly reference: object }
  | { readonly key: string; readonly kind: "publication"; readonly reference: PublishingPort };

export function portKeys(requirements: Requirements): readonly PortCall[] {
  return Object.freeze(
    Object.entries(requirements).flatMap(([key, required]): PortCall[] => {
      const reference = isOptionalDependency(required) ? required.reference : required;
      if (isPublisher(reference) || isSubscription(reference)) {
        return [{ key, kind: "publication", reference }];
      }
      return isReader(reference) || isWriter(reference) || isOperation(reference)
        ? [{ key, kind: "call", reference }]
        : [];
    }),
  );
}

/**
 * Makes each resolved port a boundary of the execution, whatever consumes it and however it is bound. A
 * publication stages within a Unit of Work and otherwise inherits the execution's signal and trace. A cancellation
 * checkpoint precedes each call, as at a suspension point: a cancelled execution stops there instead of starting
 * more work; a settling Unit of Work is never interrupted. The call's failure, also a thenable's rejection, is the
 * plug's own, except a Flow error of another execution, which becomes an internal failure of this one. An operation
 * belongs to this execution, so its internal failure passes through. An absent optional port stays absent.
 */
export function addCheckpoints(
  values: Record<string, unknown>,
  ports: readonly PortCall[],
  environment: ExecutionEnvironment,
): void {
  const uow = environment.uow;

  for (const port of ports) {
    const { key, reference } = port;
    const value = values[key];

    if (value === undefined) {
      continue;
    }

    if (port.kind === "publication") {
      values[key] = scopedPublication(value as Publishing, environment, port.reference);
      continue;
    }

    if (typeof value !== "function") {
      continue;
    }

    const call = value as Call;
    const operation = isOperation(reference);

    values[key] = (...args: never[]) => {
      const signal = uow.executionSignal;
      signal?.throwIfAborted();

      const failed = (error: unknown): unknown =>
        operation && signal?.aborted !== true && InternalBehaviorError.is(error) ? error : plugFailure(error, signal);

      return mapFailure(
        () =>
          isWriter(reference) && !isRecorded(call) ? uow.write(() => call(...args), args, reference) : call(...args),
        failed,
      );
    };
  }
}
