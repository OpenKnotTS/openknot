import { InternalBehaviorError } from "../errors.ts";
import type { Outcome } from "../outcome.ts";
import { classify, requireOutcome as checkOutcome } from "./safety.ts";

export function requireOutcome(value: unknown): asserts value is Outcome<unknown, Error> {
  checkOutcome(value, "Behavior functions must return an Outcome.");
}

const classified = [InternalBehaviorError];

/** Behavior executions own no signal, so none of their failures is a cancellation of their own. */
function behaviorError(cause: unknown, boundary: string): InternalBehaviorError {
  return classify(cause, { classified, internal: (unexpected) => InternalBehaviorError(unexpected, boundary) });
}

/** Authored failures stay Outcomes. A throw stays a throw, classified, and never joins the authored errors. */
export function safely<T, E extends Error>(boundary: string, run: () => Outcome<T, E>): Outcome<T, E> {
  try {
    const result = run();
    requireOutcome(result);
    return result;
  } catch (cause: unknown) {
    throw behaviorError(cause, boundary);
  }
}

export async function safelyAsync<T, E extends Error>(
  boundary: string,
  run: () => Outcome<T, E> | PromiseLike<Outcome<T, E>>,
): Promise<Outcome<T, E>> {
  try {
    const result = await run();
    requireOutcome(result);
    return result;
  } catch (cause: unknown) {
    throw behaviorError(cause, boundary);
  }
}
