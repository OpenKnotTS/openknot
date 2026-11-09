import { BehaviorBindingError } from "./errors.ts";
import type { Event } from "./event.ts";
import type { RuntimeOperation } from "./internal/execution.ts";
import { createOperationExecutor } from "./internal/execution.ts";
import type {
  ExecutableOperation,
  Operation,
  OperationDefinition,
  OperationExecutionResult,
  Requirements,
} from "./operation.ts";
import { isOperation } from "./operation.ts";
import type { ReaderDefinition, ReaderFunction } from "./reader.ts";
import { isReader } from "./reader.ts";
import type {} from "./wire.ts";
import type { ValueOverride } from "@openknot-ts/wire";
type RuntimeDependency = ReaderFunction | RuntimeOperation;

/**
 * Convenience for scripts, experiments and tests outside application wiring.
 * Uses only the supplied overrides; resource ownership and scopes stay with the caller.
 */
export function standalone<Input, R extends Requirements, Result extends OperationExecutionResult, E extends Event>(
  definition: Operation<Input, R, Result, E>,
  overrides?: readonly ValueOverride[],
): ExecutableOperation<Input, Result, E>;
export function standalone(
  definition: OperationDefinition,
  overrides: readonly ValueOverride[] = [],
): RuntimeOperation {
  if (!isOperation(definition)) {
    throw BehaviorBindingError("standalone() expects an operation.");
  }
  return createStandaloneOperation(definition, overrides);
}

function createStandaloneOperation(
  definition: OperationDefinition,
  overrides: readonly ValueOverride[],
): RuntimeOperation {
  const readers = new Map<ReaderDefinition, ReaderFunction>();
  for (const { target, value } of overrides) {
    if (!isReader(target) || typeof value !== "function") {
      throw BehaviorBindingError("standalone() overrides readers with functions.");
    }
    if (readers.has(target)) {
      throw BehaviorBindingError("Multiple implementations supplied for the same reader.");
    }
    readers.set(target, value as ReaderFunction);
  }

  const operations = new Map<OperationDefinition, RuntimeOperation>();
  const resolving = new Set<OperationDefinition>();

  function resolve(current: OperationDefinition, path: readonly string[]): RuntimeOperation {
    const existing = operations.get(current);

    if (existing !== undefined) {
      return existing;
    }

    if (resolving.has(current)) {
      throw BehaviorBindingError(`Operation dependency cycle: ${path.join(" -> ")}`);
    }

    resolving.add(current);

    const dependencies: Record<string, RuntimeDependency> = Object.create(null) as Record<string, RuntimeDependency>;

    for (const [key, required] of Object.entries(current.requirements)) {
      if (isReader(required)) {
        const implementation = readers.get(required);

        if (implementation === undefined) {
          throw BehaviorBindingError(`Missing reader implementation: ${[...path, key].join(" -> ")}`);
        }

        dependencies[key] = implementation;
      } else if (isOperation(required)) {
        dependencies[key] = resolve(required, [...path, key]);
      } else {
        throw BehaviorBindingError(`Invalid requirement: ${key}`);
      }
    }

    const ctx = Object.freeze(dependencies);
    const boundary = current.tag ?? path.join(" -> ");
    const execute = createOperationExecutor(current, ctx, boundary);

    operations.set(current, execute);
    resolving.delete(current);

    return execute;
  }

  return resolve(definition, ["operation"]);
}
