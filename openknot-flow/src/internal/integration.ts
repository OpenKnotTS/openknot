import type { DefinitionIntegration } from "@openknot-ts/wire";

export function integration(references: readonly object[] = []): DefinitionIntegration {
  return Object.freeze({
    name: "@openknot-ts/flow",
    references: Object.freeze([...references]),
    load: async () => (await import("./wire/adapter.ts")).createFlowAdapter(),
  });
}
