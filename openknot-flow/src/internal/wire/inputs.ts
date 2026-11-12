import type { InputPortDefinition, Requirements } from "../../definitions.ts";
import { isInputPort, snapshotRequirements } from "../../definitions.ts";
import { isExposure } from "../../exposure.ts";
import { guardedReferences } from "../../guard.ts";
import { bindInputSource, createInputInvoker } from "../runtime.ts";
import type { AdapterRuntime, FamilyAdapter } from "./shared.ts";
import { requireContext } from "./shared.ts";
import type { Definition, PlugDefinition } from "@openknot-ts/wire";
import { isPlug, resource, unit } from "@openknot-ts/wire";

function isInputPlug(value: unknown): value is PlugDefinition & { readonly port: InputPortDefinition } {
  return isPlug(value) && isInputPort(value.port);
}

/** Input ports resolve to invokers; input plugs bind them to native sources, as resources that bring work in. */
export function createInputAdapter(runtime: AdapterRuntime): FamilyAdapter {
  return (definition, context) => {
    if (isInputPort(definition)) {
      const selected = requireContext(context);
      return {
        reference: definition,
        references: [
          ...(isExposure(definition) ? guardedReferences(definition) : Object.values(definition.requirements)),
          runtime.environment,
        ] as readonly Definition[],
        // Every invocation opens a scope of its own, for this port.
        opensScope: true,
        provider: unit({
          requirements: { carrier: runtime.carrier },
          factory: ({ carrier }) => createInputInvoker(definition, runtime.host(selected, carrier)),
        }),
      };
    }
    if (isInputPlug(definition)) {
      if (Object.keys(definition.options).length > 0) {
        throw new TypeError("Unknown input plug option");
      }
      snapshotRequirements(definition.requirements);
      const requirements = { ...definition.requirements, __inputPort: definition.port } as Requirements & {
        readonly __inputPort: InputPortDefinition;
      };
      return {
        reference: definition,
        source: true,
        provider: resource({
          requirements: requirements as Readonly<Record<string, Definition>>,
          initialize: (values, { signal }) => {
            const { __inputPort, ...dependencies } = values;
            return bindInputSource(
              definition,
              dependencies,
              __inputPort as ReturnType<typeof createInputInvoker>,
              signal,
            );
          },
        }),
      };
    }
    return undefined;
  };
}
