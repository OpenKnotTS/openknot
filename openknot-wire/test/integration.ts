import type { DefinitionAdapter } from "@openknot-ts/wire";
import { DefinitionIntegrationMarker } from "@openknot-ts/wire";

/** The field that makes a test definition load its adapter, as Flow's and Behavior's definitions do. */
export function integratedBy(name: string, adapter: () => DefinitionAdapter) {
  return { [DefinitionIntegrationMarker]: { name, references: [], load: async () => adapter() } };
}
