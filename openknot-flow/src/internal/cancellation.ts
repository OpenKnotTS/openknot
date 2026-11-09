/**
 * The one reason every completed execution aborts with, so completion creates no error of its own. It belongs to no
 * call site, so it captures none: captured call sites would name, and keep alive, whatever first loaded this module.
 */
export const completed: DOMException = Object.freeze(
  (() => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      return new DOMException("The execution completed.", "AbortError");
    } finally {
      Error.stackTraceLimit = limit;
    }
  })(),
);

export interface ExecutionLifetime {
  readonly signal: AbortSignal;
  /** Detaches the sources and aborts the signal with the completion reason. */
  end(): void;
}

/**
 * A signal that aborts with the reason of the first source to abort, as AbortSignal.any() does. An execution
 * knows when it ends, so it detaches its listeners then instead of leaving the sources weak references to clean up.
 */
export function executionLifetime(...sources: readonly (AbortSignal | undefined)[]): ExecutionLifetime {
  const controller = new AbortController();
  const attached: AbortSignal[] = [];

  const forward = (event: Event): void => controller.abort((event.target as AbortSignal).reason);

  for (const source of sources) {
    if (source === undefined) {
      continue;
    }

    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }

    source.addEventListener("abort", forward, { once: true });
    attached.push(source);
  }

  return {
    signal: controller.signal,
    end(): void {
      for (const source of attached) {
        source.removeEventListener("abort", forward);
      }

      controller.abort(completed);
    },
  };
}
