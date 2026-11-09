import type { HookDefinition, ResolvedHook } from "../../hook.ts";
import type { UnitOfWorkDefinition, UnitOfWorkImplementation, UowHooks } from "../../unit-of-work.ts";
import { defaultUnitOfWork, isUnitOfWork } from "../../unit-of-work.ts";
import type { RuntimeUnitOfWork } from "../uow-runtime.ts";
import type { FamilyAdapter } from "./shared.ts";
import { lifetime } from "./shared.ts";
import type { Definition } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";

const logicalTransaction: UnitOfWorkImplementation = { transaction: (work) => work() };

function hookEntries(port: UnitOfWorkDefinition) {
  const entries = Object.entries(port.hooks) as [keyof UowHooks, readonly HookDefinition[]][];
  return entries.flatMap(([phase, hooks]) => hooks.map((hook, index) => ({ phase, hook, key: `__${phase}${index}` })));
}

export function hookRequirements(port: UnitOfWorkDefinition): Readonly<Record<string, Definition>> {
  return Object.fromEntries(hookEntries(port).map(({ key, hook }) => [key, hook]));
}

export function resolvedUnitOfWork(
  port: UnitOfWorkDefinition,
  implementation: UnitOfWorkImplementation,
  values: Readonly<Record<string, unknown>>,
): RuntimeUnitOfWork {
  const hooks: Partial<Record<keyof UowHooks, ResolvedHook<never>[]>> = {};
  for (const { phase, key } of hookEntries(port)) {
    (hooks[phase] ??= []).push(values[key] as ResolvedHook<never>);
  }
  for (const values of Object.values(hooks)) {
    Object.freeze(values);
  }
  return Object.freeze({ kind: "unit-of-work", reference: port, implementation, hooks: Object.freeze(hooks) });
}

/** Only the default UoW has logical staging as its own default. */
export const adaptUnitOfWork: FamilyAdapter = (definition) => {
  if (isUnitOfWork(definition)) {
    return {
      reference: definition,
      pure: true,
      // Only the default Unit of Work has logical staging of its own; any other is a contract to bind.
      provider:
        definition === defaultUnitOfWork
          ? unit({
              lifetime,
              requirements: hookRequirements(definition),
              factory: (values) => resolvedUnitOfWork(definition, logicalTransaction, values),
            })
          : unit.contract({ lifetime }),
    };
  }
  return undefined;
};
