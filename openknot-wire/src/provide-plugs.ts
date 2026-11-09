import type { Decoration } from "./decorations.ts";
import { isDecoration } from "./decorations.ts";
import type { CheckedSources, CompositionSource, DeferredModule, SourceModule } from "./modules.ts";
import { composeModule } from "./modules.ts";
import type { PlugDefinition } from "./plug.ts";
import { isPlug } from "./plug.ts";
import type { Provider } from "./providers.ts";
import { isProvider } from "./providers.ts";

type PlugEntry = PlugDefinition | Decoration | Provider<unknown, never, "unit" | "resource">;

export type PlugSource = CompositionSource<PlugEntry>;

/** A plug package's module, passed to defineApplication({ modules }). */
export type ProvidedPlugs<N = any, G = any> = DeferredModule<N, G>;

function isEntry(value: unknown): boolean {
  if (isProvider(value)) {
    // A contract declares a reference without an implementation; a plug module supplies implementations.
    return (value.kind === "unit" && value.required !== true) || value.kind === "resource";
  }
  return isPlug(value) || isDecoration(value);
}

/** Plugs provide bindings, resources, units and decorations; application hooks belong to the container. */
export function providePlugs<const Sources extends readonly unknown[]>(
  sources: Sources & CheckedSources<Sources, PlugSource>,
): SourceModule<Sources> {
  return composeModule({
    sources: sources as readonly PlugSource[],
    accepts: isEntry,
    label: "providePlugs()",
  }) as SourceModule<Sources>;
}
