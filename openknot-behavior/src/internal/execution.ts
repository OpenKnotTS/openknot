import { InternalBehaviorError } from "../errors.ts";
import type { OperationDefinition, OperationOutput } from "../operation.ts";
import { OperationRun } from "../operation.ts";
import type { Outcome } from "../outcome.ts";
import { failure, success } from "../outcome.ts";
import { isReader } from "../reader.ts";
import { requireOutcome, safelyAsync } from "./operation-safety.ts";
import { mapFailure } from "@openknot-ts/wire/internal/synchronous";

export type RuntimeOperation = (input: unknown) => Promise<Outcome<unknown, Error>>;

type Read = (...args: never[]) => unknown;

/**
 * A reader is a plug: an internal failure it carries belongs to another execution, so it becomes this operation's
 * own, with the original as its cause. A nested operation belongs to this execution and keeps its failure.
 */
function readerBoundary(read: Read, boundary: string): Read {
  const foreign = (error: unknown): unknown =>
    InternalBehaviorError.is(error) ? InternalBehaviorError(error, boundary) : error;

  return (...args) => mapFailure(() => read(...args), foreign);
}

/** Validates one authored change and returns a frozen copy that keeps its state by reference. */
function changeOf(output: unknown): OperationOutput<unknown> {
  if (typeof output !== "object" || output === null) {
    throw new TypeError("Operation output must describe a created, updated, deleted or unchanged result.");
  }

  const changeType = (output as { readonly changeType?: unknown }).changeType;

  switch (changeType) {
    case "created":
    case "updated":
      if (!("next" in output) || "previous" in output || "current" in output) {
        throw new TypeError("Created/updated changes require only a next state.");
      }
      return Object.freeze({ changeType, next: output.next });

    case "deleted":
      if (!("previous" in output) || "next" in output || "current" in output) {
        throw new TypeError("Deleted changes require only a previous state.");
      }
      return Object.freeze({ changeType, previous: output.previous });

    case "unchanged":
      if (!("current" in output) || "next" in output || "previous" in output) {
        throw new TypeError("Unchanged results require only a current state.");
      }
      return Object.freeze({ changeType, current: output.current });

    default:
      throw new TypeError("Operation output must describe a created, updated, deleted or unchanged result.");
  }
}

/** Shared execution boundary; callers resolve dependencies before constructing it. */
export function createOperationExecutor(
  definition: OperationDefinition,
  dependencies: object,
  boundary: string,
): RuntimeOperation {
  const resolved: Record<string, unknown> = { ...dependencies };

  for (const [key, required] of Object.entries(definition.requirements)) {
    if (isReader(required) && typeof resolved[key] === "function") {
      resolved[key] = readerBoundary(resolved[key] as Read, boundary);
    }
  }

  const ctx = Object.freeze(resolved);

  return (input) =>
    safelyAsync(boundary, async () => {
      // Authoring signatures check input/context. The runtime holds heterogeneous
      // definitions, so these types are erased only at this invocation boundary.
      const result = await definition[OperationRun](input as never, ctx as never);

      requireOutcome(result);

      if (result.isError) {
        return failure(result.error);
      }

      const draft = result.value;

      if (typeof draft !== "object" || draft === null || !("output" in draft)) {
        throw new TypeError("Operation success must contain an output field.");
      }

      const authored: unknown = draft.output;
      const change = Array.isArray(authored) ? Object.freeze(Array.from(authored, changeOf)) : changeOf(authored);
      const changes: readonly OperationOutput<unknown>[] = Array.isArray(change) ? change : [change];

      if (!("events" in draft)) {
        return success(Object.freeze({ output: change }));
      }

      const events: unknown = draft.events;

      if (!Array.isArray(events)) {
        throw new TypeError("Operation events must be an array.");
      }

      const snapshot: unknown[] = [...events];

      if (snapshot.length !== 0 && changes.every(({ changeType }) => changeType === "unchanged")) {
        throw new TypeError("Operations without changes cannot emit events.");
      }

      for (const event of snapshot) {
        if (
          typeof event !== "object" ||
          event === null ||
          !("type" in event) ||
          typeof event.type !== "string" ||
          event.type.length === 0
        ) {
          throw new TypeError("Domain events require a non-empty type string.");
        }
      }

      return success(
        Object.freeze({
          output: change,
          events: Object.freeze(snapshot),
        }),
      );
    });
}
