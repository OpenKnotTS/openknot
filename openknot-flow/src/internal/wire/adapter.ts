import { createHandlerAdapter } from "./handlers.ts";
import { createInputAdapter } from "./inputs.ts";
import { createOutputAdapter } from "./outputs.ts";
import type { FamilyAdapter } from "./shared.ts";
import { createAdapterRuntime } from "./shared.ts";
import { adaptUnitOfWork } from "./unit-of-work.ts";
import type { AdaptedDefinition, DefinitionAdapter, DefinitionAdapterContext } from "@openknot-ts/wire";

/** One adapter per application; each definition family adapts only its own kinds. */
export function createFlowAdapter(): DefinitionAdapter {
  const runtime = createAdapterRuntime();
  const families: readonly FamilyAdapter[] = [
    createHandlerAdapter(runtime),
    adaptUnitOfWork,
    createOutputAdapter(runtime),
    createInputAdapter(runtime),
  ];
  return Object.freeze({
    name: "@openknot-ts/flow",
    adapt(definition: object, context?: DefinitionAdapterContext): AdaptedDefinition | undefined {
      for (const adapt of families) {
        const adapted = adapt(definition, context);
        if (adapted !== undefined) {
          return adapted;
        }
      }
      return undefined;
    },
  });
}
