import type { Bindable, BindingFunction, ImplementationBinding } from "./internal/bindable.ts";
import { bindable, ImplementationBindingMarker, isBindableBinding } from "./internal/bindable.ts";
import type { Composition } from "./internal/composable.ts";
import { composable } from "./internal/composable.ts";
import { integration } from "./internal/integration.ts";
import { BindPort, DefinitionIntegrationMarker, hasMarker } from "@openknot-ts/wire/internal/marker";

/** Erases heterogeneous function parameters without allowing unsafe any. */
export type ReaderFunction = BindingFunction;

export const ReaderMarker = Symbol.for("@openknot-ts/behavior/reader");
export const ReaderBindingMarker = Symbol.for("@openknot-ts/behavior/reader-binding");

export interface ReaderDefinition {
  readonly [ReaderMarker]: true;
  readonly kind: "reader";
}

export interface Reader<F extends ReaderFunction> extends ReaderDefinition, Bindable<F, ReaderBinding<F>> {}

export interface ReaderBinding<F extends ReaderFunction = ReaderFunction> extends ImplementationBinding<F> {
  readonly [ReaderBindingMarker]: true;
  readonly reader: Reader<F>;
}

function createReader<F extends ReaderFunction>(): Reader<F> {
  return bindable<F, Reader<F>, ReaderBinding<F>>({
    name: "reader",
    define: (bindPort) => ({
      [ReaderMarker]: true,
      [DefinitionIntegrationMarker]: integration(),
      kind: "reader",
      [BindPort]: bindPort,
    }),
    bind: (reader, implementation) => ({
      [ImplementationBindingMarker]: true,
      [ReaderBindingMarker]: true,
      [DefinitionIntegrationMarker]: integration([reader]),
      reader,
      implementation,
    }),
  });
}

export function isReader(value: unknown): value is ReaderDefinition {
  return hasMarker(value, ReaderMarker);
}

export function isReaderBinding(value: unknown): value is ReaderBinding {
  return isBindableBinding(value, ReaderBindingMarker, "reader", isReader);
}

export const ReaderCompositionMarker = Symbol.for("@openknot-ts/behavior/reader-composition");

export interface ReaderComposition<
  P extends Readonly<Record<string, ReaderDefinition>> = Readonly<Record<string, ReaderDefinition>>,
> extends Composition<typeof ReaderCompositionMarker, "reader-composition", P> {}

/** Optional grouping metadata; member identities and bindings remain independent. */
export const reader: typeof createReader & {
  readonly compose: <const P extends Readonly<Record<string, ReaderDefinition>>>(members: P) => ReaderComposition<P>;
} = composable(createReader, {
  name: "reader",
  memberName: "reader",
  marker: ReaderCompositionMarker,
  kind: "reader-composition",
  isMember: isReader,
  metadata: (members) => ({ [DefinitionIntegrationMarker]: integration(members) }),
});

export function isReaderComposition(value: unknown): value is ReaderComposition {
  return hasMarker(value, ReaderCompositionMarker);
}
