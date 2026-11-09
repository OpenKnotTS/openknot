import type { DefinitionAdapter, DefinitionIntegration } from "../adapters.ts";
import { isOptionalDependency } from "../dependencies.ts";
import type { ModuleSelection } from "../modules.ts";
import { isPlug } from "../plug.ts";
import type { Definition, Requirements } from "../providers.ts";
import { isProvider } from "../providers.ts";
import { DefinitionIntegrationMarker } from "./marker.ts";

/** An optional requirement leads to its reference, whose integration an override of it needs as well. */
const referencesOf = (requirements: Requirements): object[] =>
  Object.values(requirements).map((required) => (isOptionalDependency(required) ? required.reference : required));

export async function loadDefinitionAdapters(
  selections: readonly ModuleSelection[],
  additional: readonly Definition[] = [],
): Promise<readonly DefinitionAdapter[]> {
  const adapters: DefinitionAdapter[] = [];
  const names = new Set<string>();
  const seen = new Set<object>();
  const queue: object[] = [...selections.flatMap((selection) => selection.definitions), ...additional];

  for (let index = 0; index < queue.length; index++) {
    const definition = queue[index];

    if (definition === undefined || seen.has(definition)) {
      continue;
    }

    seen.add(definition);

    if (isPlug(definition)) {
      queue.push(definition.port, ...referencesOf(definition.requirements));
    }

    if (isProvider(definition)) {
      queue.push(...referencesOf(definition.requirements), ...(definition.provides ? [definition.provides] : []));
      if (definition.kind === "collection" && "members" in definition) {
        queue.push(...(definition.members as readonly object[]));
      }
    }

    if (!(DefinitionIntegrationMarker in definition)) {
      continue;
    }

    const metadata = definition[DefinitionIntegrationMarker] as DefinitionIntegration;

    if (
      typeof metadata?.name !== "string" ||
      typeof metadata.load !== "function" ||
      !Array.isArray(metadata.references)
    ) {
      throw new TypeError("Invalid definition integration metadata.");
    }

    queue.push(...metadata.references);

    if (names.has(metadata.name)) {
      continue;
    }

    const adapter = await metadata.load();

    if (adapter.name !== metadata.name || typeof adapter.adapt !== "function") {
      throw new TypeError(`Invalid definition integration '${metadata.name}'.`);
    }

    names.add(metadata.name);
    adapters.push(adapter);
  }
  return Object.freeze(adapters);
}
