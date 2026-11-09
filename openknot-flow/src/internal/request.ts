import type { ExecutionOptions } from "../execution.ts";

/**
 * One reading of every input request: an exposure's, a listener's, a scheduler's and a subscription's. A request
 * is an object read once, through its own fields only, before any asynchronous step, so inherited values and
 * getters never take part.
 */
export function requireRequest(request: unknown): object {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new TypeError("An input request must be an object");
  }
  return request;
}

/** A request's own field; an absent one, such as a void input left out, reads as undefined. */
export function ownField(request: object, name: string): unknown {
  return Object.hasOwn(request, name) ? Reflect.get(request, name) : undefined;
}

/** The execution options a request carries, each read once from its own fields. */
export function executionOptions(request: object): ExecutionOptions {
  const options: Record<string, unknown> = {};
  for (const name of ["signal", "actor", "propagation", "traceAttributes"]) {
    const value = ownField(request, name);
    if (value !== undefined) {
      options[name] = value;
    }
  }

  // The signal is checked where it is followed; the other options are trusted boundary values.
  return Object.freeze(options) as ExecutionOptions;
}
