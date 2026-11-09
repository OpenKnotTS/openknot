import type { ExecutionOptions } from "../../execution.ts";
import { createExecutionEnvironment, executionIdentity } from "../execution-runtime.ts";
import type { InputHost, RuntimeScope } from "../runtime.ts";
import type { ExecutionTrace } from "../tracing.ts";
import { traceExecution } from "../tracing.ts";
import { createUnitOfWorkExecutor } from "../uow-runtime.ts";
import { unitOfWorkChanges } from "./changes.ts";
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import type { AdaptedDefinition, Definition, DefinitionAdapterContext, Lifetime } from "@openknot-ts/wire";
import { optional, unit } from "@openknot-ts/wire";

/** Adapts one family of definitions; unrelated definitions return undefined. */
export type FamilyAdapter = (definition: object, context?: DefinitionAdapterContext) => AdaptedDefinition | undefined;

/** Execution dependencies and output bindings are scoped. */
export const lifetime: Lifetime = "scoped";

/** Native units shared by every Flow definition of one application. */
export function createAdapterRuntime() {
  const carrier = unit({
    requirements: { trace: optional(trace) },
    provides: unitOfWorkChanges,
    factory: ({ trace }) => createUnitOfWorkExecutor(trace),
  });
  // One per application: each scope's request is a frame it reads through async context.
  const environment = unit({
    requirements: { trace: optional(trace), carrier },
    factory: ({ trace, carrier }) => createExecutionEnvironment(carrier, trace),
  });
  function host(context: DefinitionAdapterContext, tracing: Tracing | undefined): InputHost {
    return {
      tracing,
      get status(): string {
        return context.status;
      },
      stopping: context.stopping,
      get intakeOpen(): boolean {
        return context.intakeOpen;
      },
      withScope<T>(
        work: (scope: RuntimeScope) => T | Promise<T>,
        scopeOptions: ExecutionOptions & {
          readonly cleanup?: boolean;
          readonly root?: object;
          readonly bounded?: boolean;
        } = {},
        operation?: Pick<ExecutionTrace, "kind" | "reference">,
      ): Promise<T> {
        const { cleanup = false, root, bounded = false, ...options } = scopeOptions;
        const metadata = executionIdentity(options.actor);
        const snapshot = {
          ...options,
          ...(options.propagation === undefined ? {} : { propagation: Object.freeze({ ...options.propagation }) }),
          ...(options.traceAttributes === undefined
            ? {}
            : { traceAttributes: Object.freeze({ ...options.traceAttributes }) }),
        };
        const execute = async () =>
          context.withScope(
            (scope) => {
              const execution = scope.resolve(environment);
              return execution.enter(snapshot, metadata, bounded, () =>
                work({ execution, resolve: (reference) => scope.resolve(reference as Definition) }),
              );
            },
            // The execution's signal also cancels acquiring the scope's resources, which its root selects.
            {
              cleanup,
              ...(root === undefined ? {} : { root: root as Definition }),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
          );
        return operation === undefined
          ? execute()
          : traceExecution(
              tracing,
              {
                ...operation,
                propagation: snapshot.propagation,
                attributes: snapshot.traceAttributes,
              },
              execute,
            );
      },
    };
  }
  return { carrier, environment, host };
}
export type AdapterRuntime = ReturnType<typeof createAdapterRuntime>;

export function requireContext(context: DefinitionAdapterContext | undefined): DefinitionAdapterContext {
  if (context === undefined) {
    throw new Error("Flow integration requires a wire runtime context");
  }
  return context;
}
