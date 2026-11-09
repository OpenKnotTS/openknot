import type { TargetedRoot } from "./graph.ts";
import { hasMarker } from "./internal/marker.ts";
import type { NoRequirements, RequirementsOptions } from "./internal/requirements.ts";
import { snapshotRequirements } from "./internal/requirements.ts";
import type { Definition, Requirements, Resolved, ResolvedReferences } from "./providers.ts";

const DecorationMarker = Symbol.for("@openknot-ts/wire/decoration");

/**
 * Wraps one definition's implementation. Modules list it; the application's modules decide whether it applies and in
 * what order, the first decoration of a target being the innermost. Its requirements count while its target is not
 * overridden.
 */
export interface Decoration<
  T extends Definition = Definition,
  R extends Requirements = Requirements,
> extends TargetedRoot<T, { readonly requirements: R }> {
  readonly [DecorationMarker]: true;
  readonly kind: "decoration";
  readonly target: T;
  readonly requirements: R;
  readonly wrap: (inner: never, dependencies: never) => unknown;
}

/** `decorate(target, { requirements?, wrap })`: the wrapper receives and returns the target's own value type. */
export function decorate<const T extends Definition, const R extends Requirements = NoRequirements>(
  target: T,
  options: RequirementsOptions<R> & {
    readonly wrap: (inner: Resolved<T>, dependencies: ResolvedReferences<R>) => NoInfer<Resolved<T>>;
  },
): Decoration<T, R> {
  if ((typeof target !== "object" || target === null) && typeof target !== "function") {
    throw new TypeError("decorate() requires a target definition.");
  }

  if (typeof options !== "object" || options === null || typeof options.wrap !== "function") {
    throw new TypeError("decorate() requires { wrap, requirements? }.");
  }

  return Object.freeze({
    [DecorationMarker]: true as const,
    kind: "decoration" as const,
    target,
    requirements: snapshotRequirements(options.requirements),
    wrap: options.wrap as Decoration["wrap"],
  }) as unknown as Decoration<T, R>;
}

export function isDecoration(value: unknown): value is Decoration {
  return hasMarker(value, DecorationMarker);
}
