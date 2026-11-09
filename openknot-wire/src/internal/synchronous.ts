/** Whether a value is a promise or another thenable, as `await` and `Promise.resolve()` treat it. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Calls work and maps its failure, whether it throws or returns a thenable that rejects; other results pass through. */
export function mapFailure<T>(work: () => T, map: (error: unknown) => unknown): T {
  try {
    const result = work();
    return isThenable(result)
      ? (Promise.resolve(result).catch((error: unknown) => Promise.reject(map(error))) as T)
      : result;
  } catch (error) {
    throw map(error);
  }
}

/**
 * Whether a synchronous contract received a promise or thenable. Its eventual rejection is observed, so the
 * caller's contract error is the one failure reported, not an unhandled rejection besides it.
 */
export function discardedThenable(value: unknown): value is PromiseLike<unknown> {
  const thenable = isThenable(value);
  if (thenable) {
    void Promise.resolve(value).catch(() => undefined);
  }
  return thenable;
}
