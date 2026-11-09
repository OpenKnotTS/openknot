import type { BindPort } from "@openknot-ts/wire/internal/marker";
import { hasMarker } from "@openknot-ts/wire/internal/marker";

/** Heterogeneous callable contracts keep their concrete signature at the boundary. */
export type BindingFunction = (...args: never[]) => unknown;

export const ImplementationBindingMarker = Symbol.for("@openknot-ts/behavior/implementation-binding");

export interface ImplementationBinding<F extends BindingFunction> {
  readonly [ImplementationBindingMarker]: true;
  readonly implementation: F;
}

export interface Bindable<F extends BindingFunction, B extends ImplementationBinding<F>> {
  [BindPort](implementation: F): B;
}

/** A binding owns its implementation; the original definition is never mutated. */
export function bindable<
  F extends BindingFunction,
  D extends Bindable<F, B>,
  B extends ImplementationBinding<F>,
>(options: {
  readonly name: string;
  readonly define: (bindPort: (implementation: F) => B) => D;
  readonly bind: (definition: D, implementation: F) => B;
}): D {
  const { name, define, bind } = options;

  const definition: D = Object.freeze(
    define((implementation: F): B => {
      if (typeof implementation !== "function") {
        throw new TypeError(`A ${name}'s implementation must be a function.`);
      }
      return Object.freeze(bind(definition, implementation));
    }),
  );

  return definition;
}

/** Shared by standalone convenience execution across dependency kinds. */
export function isImplementationBinding(value: unknown): value is ImplementationBinding<BindingFunction> {
  return (
    hasMarker(value, ImplementationBindingMarker) &&
    "implementation" in value &&
    typeof value.implementation === "function"
  );
}

/** Specific markers and reference fields keep reader/writer bindings distinct. */
export function isBindableBinding(
  value: unknown,
  marker: symbol,
  referenceKey: string,
  isDefinition: (reference: unknown) => boolean,
): boolean {
  return (
    isImplementationBinding(value) &&
    hasMarker(value, marker) &&
    referenceKey in value &&
    isDefinition(Reflect.get(value, referenceKey))
  );
}
