import type { DefinitionIntegration } from "@openknot-ts/wire";

export function integration(references: readonly object[] = []): DefinitionIntegration {
  return Object.freeze({
    name: "@openknot-ts/behavior",
    references: Object.freeze([...references]),
    load: async () => (await import("./wire/adapter.ts")).behaviorAdapter(),
  });
}
