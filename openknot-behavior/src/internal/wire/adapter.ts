import { isOperation } from "../../operation.ts";
import { isReader } from "../../reader.ts";
import { createOperationExecutor } from "../execution.ts";
import { adaptReaderPlug } from "./plugs.ts";
import type { AdaptedDefinition, DefinitionAdapter } from "@openknot-ts/wire";
import { isPlug, unit } from "@openknot-ts/wire";

/** Operations and readers are execution-scoped. */
const lifetime = "scoped";

export function behaviorAdapter(): DefinitionAdapter {
  return Object.freeze({
    name: "@openknot-ts/behavior",
    adapt(definition: object): AdaptedDefinition | undefined {
      if (isPlug(definition)) {
        return adaptReaderPlug(definition);
      }

      if (isReader(definition)) {
        return { reference: definition, provider: unit.contract({ lifetime }) };
      }

      if (isOperation(definition)) {
        return {
          reference: definition,
          pure: true,
          provider: unit({
            requirements: definition.requirements,
            factory: (ctx) => createOperationExecutor(definition, ctx, definition.tag ?? "operation"),
            lifetime,
          }),
        };
      }

      return undefined;
    },
  });
}
