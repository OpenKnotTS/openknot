import type { ManagedResource } from "../providers.ts";
import { kindOf } from "./composition.ts";
import type { Registration, ResolutionScope } from "./container.ts";
import type { AcquisitionStep } from "./plans.ts";

export type Cleanup = () => void | Promise<void>;

/**
 * One lifecycle step: an acquisition or a task. It does not begin once its signal has aborted,
 * and a step that failed because its signal aborted reports the cancellation; any other failure is its own,
 * as in Flow's execution boundary.
 */
export async function step<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  try {
    return await work();
  } catch (error) {
    const aborted =
      error === signal.reason ||
      (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError");

    if (signal.aborted && aborted) {
      throw signal.reason;
    }

    throw error;
  }
}

export function throwWithCleanup(error: unknown, cleanupErrors: readonly unknown[]): never {
  if (cleanupErrors.length === 0) {
    throw error;
  }
  throw new AggregateError([error, ...cleanupErrors], "Operation failed and cleanup also failed.", { cause: error });
}

export function checkMethod(value: unknown, method: string, identity: object): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !(method in value) ||
    typeof Reflect.get(value, method) !== "function"
  ) {
    throw new TypeError(`The ${kindOf(identity)} must return an object with ${method}().`);
  }
}

export interface Acquisition extends AcquisitionStep {
  readonly registration: Registration;
}

/**
 * Acquires every resource of a plan as soon as the ones it waits for are ready, so independent resources
 * are acquired in parallel. The first failure aborts the acquisitions still in progress, and what was
 * acquired is released in reverse completion order with the rest of the owner's cleanup.
 */
export async function initializeResources(
  acquisitions: readonly Acquisition[],
  scope: ResolutionScope,
  cleanup: Cleanup[],
  cancellation: AbortSignal | undefined,
): Promise<void> {
  // A cancelled owner does not proceed, even when every initializer completed: what was acquired is released
  // with the owner's cleanup and the cancellation is reported.
  if (acquisitions.length === 0) {
    return cancellation?.throwIfAborted();
  }

  // One signal for this acquisition: it follows the caller's cancellation and aborts on the first failure.
  const run = new AbortController();
  const cancel = (): void => run.abort(cancellation?.reason);

  if (cancellation?.aborted) {
    cancel();
  } else {
    cancellation?.addEventListener("abort", cancel, { once: true });
  }

  const signal = run.signal;
  const steps = new Map(acquisitions.map((acquisition) => [acquisition.key, acquisition]));
  const started = new Map<object, Promise<void>>();
  const failures = new Set<unknown>();

  function acquire(acquisition: Acquisition): Promise<void> {
    let pending = started.get(acquisition.key);

    if (pending !== undefined) {
      return pending;
    }

    const { key, registration, after } = acquisition;
    const ready = Promise.all(after.map((dependency) => acquire(steps.get(dependency) as Acquisition)));

    pending = ready.then(async () => {
      try {
        const handle = await step(signal, async () => {
          // The descriptor resolves its requirements in the scope that owns the resource.
          const descriptor = registration.build(scope.resolve);
          checkMethod(descriptor, "initialize", key);
          return (descriptor as ManagedResource<unknown>).initialize({ signal });
        });

        checkMethod(handle, "release", key);
        cleanup.push(() => handle.release());

        if (!("value" in handle)) {
          throw new TypeError("A resource returned a handle without value.");
        }

        scope.provide(key, handle.value);
      } catch (error) {
        failures.add(error);
        if (!signal.aborted) {
          run.abort(error);
        }
        throw error;
      }
    });

    started.set(key, pending);
    return pending;
  }

  try {
    await Promise.allSettled(acquisitions.map(acquire));
  } finally {
    cancellation?.removeEventListener("abort", cancel);
  }

  // Acquisitions the first failure cancelled report it too, and are not repeated; independent failures join it.
  const [first] = failures;

  if (failures.size === 1) {
    throw first;
  }
  if (failures.size > 1) {
    throw new AggregateError([...failures], "Resource acquisition failed.", { cause: first });
  }

  cancellation?.throwIfAborted();
}
