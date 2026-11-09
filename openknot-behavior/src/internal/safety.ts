import type { Failure, Outcome } from "../outcome.ts";
import { failure, isOutcome } from "../outcome.ts";

/** Validate without replacing expected outcomes or their original errors. */
export function requireOutcome(value: unknown, message: string): asserts value is Outcome<unknown, Error> {
  if (!isOutcome(value)) {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      // Sync-only contracts must reject promises/thenables while observing any
      // rejection. Promise.resolve also contains throwing `then` getters.
      void Promise.resolve(value).catch(() => undefined);
    }
    throw new TypeError(message);
  }
}

/** A framework error factory, known by its narrowing check. */
export interface ErrorKind<E extends Error> {
  is(value: unknown): value is E;
}

/** What one layer's boundaries admit besides authored failures: the framework errors of its own result type. */
export interface Classification<E extends Error> {
  /** Errors a framework boundary has already classified; they keep their identity. */
  readonly classified: readonly ErrorKind<E>[];
  /** An unexpected failure, wrapped with its original cause. */
  readonly internal: (cause: unknown) => E;
  /** The execution's own cancellation, for boundaries that own a signal. */
  readonly cancelled?: (cause: unknown) => E;
}

/** Whether a failure is the cancellation of the given signal rather than a failure of its own. */
export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true && (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
  );
}

/**
 * The one classification every protected boundary applies to a failure outside its authored Outcomes, such as a
 * throw: the execution's own cancellation is a separate failure, an error another boundary already classified
 * passes through unwrapped, and anything else is unexpected. Authored failures are retained as they are.
 */
export function classify<E extends Error>(cause: unknown, classification: Classification<E>, signal?: AbortSignal): E {
  if (classification.cancelled !== undefined && isCancellation(cause, signal)) {
    return classification.cancelled(cause);
  }
  for (const kind of classification.classified) {
    if (kind.is(cause)) {
      return cause;
    }
  }
  return classification.internal(cause);
}

/** Each layer supplies its own classification and optional result validation. */
export async function protectAsync<T, E extends Error>(
  run: () => T | PromiseLike<T>,
  onError: (cause: unknown) => E,
  validate?: (value: NoInfer<T>) => void,
): Promise<T | Failure<E>> {
  try {
    const result = await run();
    validate?.(result);
    return result;
  } catch (cause: unknown) {
    return failure(onError(cause));
  }
}
