import type { ExecutionActor } from "./execution.ts";
import type { HookDefinition } from "./hook.ts";
import { isHook } from "./hook.ts";
import { integration } from "./internal/integration.ts";
import type { Upserted } from "./writer.ts";
import type { Deleted } from "@openknot-ts/behavior";
import { BindPort, DefinitionIntegrationMarker, hasMarker } from "@openknot-ts/wire/internal/marker";

export const UnitOfWorkMarker = Symbol.for("@openknot-ts/flow/unit-of-work");
export const UnitOfWorkBindingMarker = Symbol.for("@openknot-ts/flow/unit-of-work-binding");

export type UnitOfWorkMode = "read-write" | "read-only";
export interface UnitOfWorkOptions {
  readonly mode: UnitOfWorkMode;
  readonly signal: AbortSignal;
  readonly actor: ExecutionActor | undefined;
}

/** Resolve with the value work returned after commit; propagate callback rejection unchanged after rollback completes.
 * The driver owns ambient native session binding. It must invoke work exactly once. */
export interface UnitOfWorkImplementation {
  transaction<T>(work: () => Promise<T>, options: UnitOfWorkOptions): Promise<T>;
}

export interface UowActive {
  readonly status: "active";
  readonly mode: UnitOfWorkMode;
}

export interface UowCommitted {
  readonly status: "committed";
  readonly mode: UnitOfWorkMode;
}

export interface UowRolledBack {
  readonly status: "rolled-back";
  readonly mode: UnitOfWorkMode;
  readonly error: Error;
}

export type UowCompleted = { readonly mode: UnitOfWorkMode } & (
  | { readonly status: "committed"; readonly error?: Error }
  | { readonly status: "rolled-back" | "unknown"; readonly error: Error }
);

export interface UowHooks {
  readonly beforeCommit?: readonly HookDefinition<UowActive>[];
  readonly afterCommit?: readonly HookDefinition<UowCommitted>[];
  readonly afterRollback?: readonly HookDefinition<UowRolledBack>[];
  readonly afterCompletion?: readonly HookDefinition<UowCompleted>[];
}

export interface CommitContext {
  latest<State>(receipt: Upserted<State> | Deleted<State>): Upserted<State> | Deleted<State>;
}

export type UnitOfWorkEffect = (context: CommitContext) => void | PromiseLike<void>;

export interface UnitOfWorkContext {
  readonly actor: ExecutionActor | undefined;
  readonly mode: UnitOfWorkMode;
  afterCommit(effect: UnitOfWorkEffect): void;
}

export interface UnitOfWorkDefinition {
  readonly [UnitOfWorkMarker]: true;
  readonly kind: "unit-of-work";
  readonly hooks: UowHooks;
  [BindPort](implementation: UnitOfWorkImplementation): UnitOfWorkBinding;
}

export interface UnitOfWorkBinding {
  readonly [UnitOfWorkBindingMarker]: true;
  readonly unitOfWork: UnitOfWorkDefinition;
  readonly implementation: UnitOfWorkImplementation;
}

export function unitOfWork(options: { readonly hooks?: UowHooks } = {}): UnitOfWorkDefinition {
  const hooks: Record<string, readonly HookDefinition[]> = {};

  if (
    options.hooks !== undefined &&
    (typeof options.hooks !== "object" || options.hooks === null || Array.isArray(options.hooks))
  ) {
    throw new TypeError("Unit of Work hooks must be a named object");
  }

  for (const [name, values] of Object.entries(options.hooks ?? {})) {
    if (
      !["beforeCommit", "afterCommit", "afterRollback", "afterCompletion"].includes(name) ||
      !Array.isArray(values) ||
      !values.every(isHook)
    ) {
      throw new TypeError(`Invalid Unit of Work hook '${name}'`);
    }
    hooks[name] = Object.freeze([...values]);
  }

  const snapshot = Object.freeze(hooks) as UowHooks;

  const definition: UnitOfWorkDefinition = Object.freeze({
    [UnitOfWorkMarker]: true as const,
    kind: "unit-of-work" as const,
    hooks: snapshot,
    [DefinitionIntegrationMarker]: integration(Object.values(snapshot).flat()),
    [BindPort](implementation: UnitOfWorkImplementation): UnitOfWorkBinding {
      if (
        typeof implementation !== "object" ||
        implementation === null ||
        typeof implementation.transaction !== "function"
      ) {
        throw new TypeError("A unit of work's implementation requires transaction()");
      }

      return Object.freeze({
        [UnitOfWorkBindingMarker]: true as const,
        unitOfWork: definition,
        implementation: Object.freeze({ transaction: implementation.transaction.bind(implementation) }),
        [DefinitionIntegrationMarker]: integration([definition]),
      });
    },
  });

  return definition;
}

/** Logical UoW by default. Bind it with a native driver for storage atomicity. */
export const defaultUnitOfWork = unitOfWork();

export function isUnitOfWork(value: unknown): value is UnitOfWorkDefinition {
  return hasMarker(value, UnitOfWorkMarker);
}

export function isUnitOfWorkBinding(value: unknown): value is UnitOfWorkBinding {
  return (
    hasMarker(value, UnitOfWorkBindingMarker) &&
    "unitOfWork" in value &&
    isUnitOfWork(value.unitOfWork) &&
    "implementation" in value &&
    typeof value.implementation === "object" &&
    value.implementation !== null &&
    "transaction" in value.implementation &&
    typeof value.implementation.transaction === "function"
  );
}
