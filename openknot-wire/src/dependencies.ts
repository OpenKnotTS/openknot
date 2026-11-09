import { hasMarker } from "./internal/marker.ts";
import type { Definition } from "./providers.ts";

const OptionalDependencyMarker = Symbol.for("@openknot-ts/wire/optional-dependency");

/** A weak reference: consume an existing binding without adding it to the graph. */
export interface OptionalDependency<D extends Definition = Definition> {
  readonly [OptionalDependencyMarker]: true;
  readonly reference: D;
}

export function optional<const D extends Definition>(reference: D): OptionalDependency<D> {
  if (
    ((typeof reference !== "object" || reference === null) && typeof reference !== "function") ||
    Array.isArray(reference) ||
    isOptionalDependency(reference)
  ) {
    throw new TypeError("optional() requires a dependency reference.");
  }

  return Object.freeze({ [OptionalDependencyMarker]: true as const, reference });
}

export function isOptionalDependency(value: unknown): value is OptionalDependency {
  return hasMarker(value, OptionalDependencyMarker);
}
