import type { DefinitionIntegration } from "@openknot-ts/wire";
import { DefinitionIntegrationMarker } from "@openknot-ts/wire/internal/marker";
import type { RequirementReferences } from "@openknot-ts/wire/internal/requirements";

type Execution = (...args: never[]) => unknown;
type Executable<Marker extends symbol, Kind extends string, Hook extends symbol, F extends Execution, D> = Readonly<
  D &
    Record<Marker, true> &
    Record<Hook, F> & {
      readonly kind: Kind;
      readonly [DefinitionIntegrationMarker]: DefinitionIntegration;
    }
>;

/** Layer-specific fields and validation stay with each primitive. */
export function executable<
  const Marker extends symbol,
  const Kind extends string,
  const Hook extends symbol,
  F extends Execution,
  D extends { readonly requirements: RequirementReferences },
>(options: {
  readonly marker: Marker;
  readonly kind: Kind;
  readonly hook: Hook;
  readonly run: F;
  readonly invalidRunMessage: string;
  readonly define: () => D;
  readonly integration: (references: readonly object[]) => DefinitionIntegration;
  readonly references?: (definition: D) => readonly object[];
}): Executable<Marker, Kind, Hook, F, D> {
  const run = options.run;

  if (typeof run !== "function") {
    throw new TypeError(options.invalidRunMessage);
  }

  const definition = options.define();
  const references = options.references?.(definition) ?? Object.values(definition.requirements);

  // Generic computed symbol keys need a local assertion, as in composable().
  return Object.freeze({
    ...definition,
    [options.marker]: true as const,
    kind: options.kind,
    [options.hook]: run,
    [DefinitionIntegrationMarker]: options.integration(references),
  }) as Executable<Marker, Kind, Hook, F, D>;
}
