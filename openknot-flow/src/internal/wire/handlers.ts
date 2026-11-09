import type { ExecutionIdentity, ExecutionActor, ExecutionOptions } from "../../execution.ts";
import { isGuard } from "../../guard.ts";
import { HandlerRun, isHandler } from "../../handlers.ts";
import type { HandlerDefinition } from "../../handlers.ts";
import { HookRun, isHook } from "../../hook.ts";
import type { UnitOfWorkContext, UnitOfWorkMode } from "../../unit-of-work.ts";
import { addCheckpoints, portKeys } from "../checkpoint.ts";
import type { ExecutionEnvironment } from "../execution-runtime.ts";
import { createGuardExecutor } from "../guard-execution.ts";
import { executionError, requireVoidOutcome } from "../safety.ts";
import type { RuntimeUnitOfWork } from "../uow-runtime.ts";
import type { AdapterRuntime, FamilyAdapter } from "./shared.ts";
import { lifetime } from "./shared.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { protectAsync } from "@openknot-ts/behavior/internal/safety";
import type { Definition } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";

type HandlerWork = (
  signal: AbortSignal,
  execution: ExecutionIdentity,
  uow: UnitOfWorkContext,
) => Promise<Outcome<unknown, Error>>;
interface Gateway {
  run(
    definition: HandlerDefinition,
    options: ExecutionOptions,
    driver: RuntimeUnitOfWork,
    mode: UnitOfWorkMode,
    work: HandlerWork,
  ): Promise<Outcome<unknown, Error>>;
}

/** Handlers, hooks and guards: internal dependencies executed within a scope. */
export function createHandlerAdapter(runtime: AdapterRuntime): FamilyAdapter {
  // One gateway for commands and queries; each call carries its own Unit of Work mode.
  const gateway = unit({
    requirements: { environment: runtime.environment },
    factory: ({ environment }): Gateway => ({
      run: async (definition, options, driver, mode, work) => {
        // environment.run() already turns every failure into an Outcome.
        const result = await environment.run(
          options,
          (signal, execution) =>
            environment.uow.run(driver, mode, execution, signal, (uow) => work(signal, execution, uow)),
          { kind: definition.kind, reference: definition },
        );
        if (result.isError) {
          environment.uow.fail(result.error);
        }
        return result;
      },
    }),
  });
  return (definition) => {
    if (isHandler(definition)) {
      // Fixed per definition, so constructing a handler in a scope only binds its resolved values.
      const keys = Object.keys(definition.requirements);
      const ports = portKeys(definition.requirements);
      const mode = definition.kind === "command" ? "read-write" : "read-only";
      // Handlers, hooks and guards read their execution from the environment, so they are built from their
      // requirements alone, once unless one of those is scoped.
      return {
        reference: definition,
        pure: true,
        provider: unit({
          lifetime,
          requirements: {
            ...definition.requirements,
            __gateway: gateway,
            __uow: definition.unitOfWork,
            __environment: runtime.environment,
          } as Readonly<Record<string, Definition>>,
          factory: (values) => {
            const environment = values.__environment as ExecutionEnvironment;
            const resolved: Record<string, unknown> = {};
            for (const key of keys) {
              resolved[key] = values[key];
            }
            addCheckpoints(resolved, ports, environment);
            const gateway = values.__gateway as Gateway;
            const unitOfWork = values.__uow as RuntimeUnitOfWork;
            return (input: unknown, options: ExecutionOptions = {}) =>
              gateway.run(definition, options, unitOfWork, mode, async (signal, execution, uow) =>
                definition[HandlerRun](
                  input as never,
                  Object.freeze({ ...resolved, signal, actor: execution.actor, uow }) as never,
                ),
              );
          },
        }),
      };
    }
    if (isHook(definition)) {
      const ports = portKeys(definition.requirements);
      return {
        reference: definition,
        pure: true,
        provider: unit({
          lifetime,
          requirements: { ...definition.requirements, __environment: runtime.environment } as Readonly<
            Record<string, Definition>
          >,
          factory: ({ __environment, ...dependencies }) => {
            const environment = __environment as ExecutionEnvironment;
            addCheckpoints(dependencies, ports, environment);
            const uow = environment.uow;
            return (input: never, ctx: { signal: AbortSignal; actor: ExecutionActor | undefined }) =>
              environment.trace({ kind: "hook", reference: definition }, async () => {
                const run = () =>
                  protectAsync(
                    () => definition[HookRun](input, Object.freeze({ ...dependencies, ...ctx }) as never),
                    (error) => executionError(error, ctx.signal),
                    (result) => requireVoidOutcome(result, "Hook run() must return a void Outcome"),
                  );
                // The hook's port calls follow the signal it was called with, also when it is called directly.
                return uow.withExecution({ signal: ctx.signal, actor: ctx.actor, propagation: uow.propagation }, run);
              });
          },
        }),
      };
    }
    if (isGuard(definition)) {
      const ports = portKeys(definition.requirements);
      return {
        reference: definition,
        pure: true,
        provider: unit({
          lifetime,
          requirements: { ...definition.requirements, __environment: runtime.environment } as Readonly<
            Record<string, Definition>
          >,
          factory: ({ __environment, ...dependencies }) => {
            const environment = __environment as ExecutionEnvironment;
            addCheckpoints(dependencies, ports, environment);
            return createGuardExecutor(definition, dependencies, environment);
          },
        }),
      };
    }
    return undefined;
  };
}
