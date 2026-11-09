import type { OptionalDependency } from "./dependencies.ts";
import { isOptionalDependency } from "./dependencies.ts";
import { hasMarker } from "./internal/marker.ts";
import type { NoRequirements, RequirementsOptions } from "./internal/requirements.ts";
import { snapshotRequirements } from "./internal/requirements.ts";
import type { PlugDefinition } from "./plug.ts";

/** A runtime marker shared by copies of this package; contains no registry. */
export const ProviderMarker = Symbol.for("@openknot-ts/wire/provider");

export type Lifetime = "singleton" | "scoped" | "transient";
type ProviderKind = "unit" | "resource" | "hook" | "collection";

/** Erases heterogeneous factory inputs without accepting unsafe `any` values. */
type Factory = (...dependencies: never[]) => unknown;

export interface ProviderOptions {
  readonly lifetime?: Lifetime;
  /** Check explicit references, or use true to check all non-optional requirements. */
  readonly whenAvailable?: true | readonly Definition[];
}

export interface ResourceOptions extends Omit<ProviderOptions, "lifetime"> {
  readonly lifetime?: Exclude<Lifetime, "transient">;
}

export interface ResourceHandle<T> {
  readonly value: T;
  release(): void | Promise<void>;
}

/** What a lifecycle step receives: resource acquisition and application hooks. */
export interface CancellationOptions {
  /**
   * Aborts when the step's result is no longer wanted: its startup or scope was cancelled while it ran.
   * A shutdown task's signal never aborts, because shutdown runs to completion.
   */
  readonly signal: AbortSignal;
}

export interface ManagedResource<T> {
  initialize(options: CancellationOptions): Promise<ResourceHandle<T>>;
}

export interface ApplicationHook {
  run(options: CancellationOptions): void | Promise<void>;
}

interface FactoryProvider<F extends Factory, K extends ProviderKind = ProviderKind> {
  readonly [ProviderMarker]: true;
  readonly kind: K;
  readonly factory: F;
  readonly lifetime: Lifetime;
  readonly requirements: Requirements;
  readonly provides?: Definition;
  readonly required?: true;
  /** A collection contract: it gathers the units that declare it through provides. */
  readonly gathers?: true;
  readonly whenAvailable?: readonly Definition[];
}

/** R keeps the requirement references, so compile-time graph checks can follow them. */
export interface Provider<
  T = unknown,
  D extends object = never,
  K extends ProviderKind = ProviderKind,
  R extends Requirements = Requirements,
> extends FactoryProvider<(dependencies: D) => T, K> {
  readonly requirements: R;
}

export type AnyProvider = FactoryProvider<Factory>;

/** A singleton collection of every unit in the composed application that declares it through provides. */
export interface CollectionContract<T = unknown> extends Provider<readonly T[], never, "collection", NoRequirements> {
  readonly gathers: true;
  readonly members: readonly Definition[];
}

/** A native unit reference that must be supplied through provides or override. */
export interface UnitContract<T = unknown> extends Provider<T, never, "unit", NoRequirements> {
  readonly required: true;
}

/** Keeps the exact binding target in the public graph rather than intersecting the optional metadata. */
export interface UnitBinding<T, R extends Requirements, P extends Definition> extends Omit<
  Provider<T, ResolvedReferences<R>, "unit", R>,
  "provides"
> {
  readonly provides: P;
}

export type ProviderArguments<P extends AnyProvider> = Parameters<P["factory"]>;
export type ProviderDependencies<P extends AnyProvider> = ProviderArguments<P>[0];
/** Optional integrations add reference and result types without runtime imports. */
export interface DefinitionTypes {}
export interface DefinitionResults<_D> {}
export type Definition = AnyProvider | PlugDefinition | DefinitionTypes[keyof DefinitionTypes];
export type Requirement = Definition | OptionalDependency;
export type Requirements = Readonly<Record<string, Requirement>>;

export type Resolved<P> =
  P extends OptionalDependency<infer D>
    ? Resolved<D> | undefined
    : P extends { readonly kind: infer K; readonly factory: (...dependencies: never[]) => infer T }
      ? K extends "resource"
        ? T extends ManagedResource<infer Value>
          ? Value
          : never
        : T
      : DefinitionResults<P>[keyof DefinitionResults<P>];

export type ResolvedReferences<R extends Requirements> = {
  readonly [K in keyof R]: Resolved<R[K]>;
};

type Declaration<R extends Requirements, T> = RequirementsOptions<R> & {
  readonly factory: (dependencies: ResolvedReferences<R>) => T;
};

/** One construction path for every provider; requirements are always explicit references. */
function defineProvider<const R extends Requirements, T, K extends ProviderKind>(
  kind: K,
  options: Declaration<R, T> & ProviderOptions & { readonly provides?: Definition },
): Provider<T, ResolvedReferences<R>, K, NoInfer<R>> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("A provider requires { factory, requirements? }.");
  }

  const factory = options.factory;
  if (typeof factory !== "function") {
    throw new TypeError("A provider requires a factory function.");
  }

  const provides = options.provides;
  // A member joins a collection contract instead of binding it, so it keeps its own lifetime and identity.
  const joins = isCollectionContract(provides);

  if (joins && kind !== "unit") {
    throw new TypeError("A collection contract gathers units.");
  }

  // A provider target is checked here; an integration's reference once the application can adapt it.
  const target = isProvider(provides) && !joins ? provides : undefined;

  if (target !== undefined && (target.provides !== undefined || target.kind !== kind)) {
    throw new TypeError("provides must reference an unbound provider of the same kind.");
  }

  const lifetime = options.lifetime ?? target?.lifetime ?? "singleton";

  if (!["singleton", "scoped", "transient"].includes(lifetime)) {
    throw new TypeError(`Unknown lifetime: ${String(lifetime)}`);
  }

  if (kind !== "unit" && kind !== "collection" && lifetime === "transient") {
    throw new TypeError(`${kind} providers cannot be transient.`);
  }

  if (kind === "hook" && lifetime !== "singleton") {
    throw new TypeError(`${kind} providers must be singleton.`);
  }

  if (target !== undefined && target.lifetime !== lifetime) {
    throw new TypeError("A binding must preserve its target's lifetime.");
  }

  const requirements = snapshotRequirements(options.requirements);
  const declaredConditions = options.whenAvailable;

  if (declaredConditions !== undefined && declaredConditions !== true && !Array.isArray(declaredConditions)) {
    throw new TypeError("whenAvailable must be true or an array of dependency references.");
  }

  const whenAvailable = Object.freeze(
    declaredConditions === true
      ? Object.values(requirements).filter((reference): reference is Definition => !isOptionalDependency(reference))
      : [...(declaredConditions ?? [])],
  );

  for (const reference of whenAvailable) {
    if (
      ((typeof reference !== "object" || reference === null) && typeof reference !== "function") ||
      Array.isArray(reference) ||
      isOptionalDependency(reference)
    ) {
      throw new TypeError("whenAvailable requires dependency references.");
    }
  }

  return Object.freeze({
    [ProviderMarker]: true as const,
    kind,
    factory,
    lifetime,
    requirements,
    ...(provides === undefined ? {} : { provides }),
    ...(whenAvailable.length === 0 ? {} : { whenAvailable }),
  });
}

type BindingTarget<K extends ProviderKind> = FactoryProvider<Factory, K>;

/** What a unit binding builds: its target's value, or one element of a collection contract. */
type BindingValue<P> = P extends CollectionContract<infer Element> ? Element : Resolved<P>;

function createUnit<
  const R extends Requirements = NoRequirements,
  const P extends BindingTarget<"unit"> | CollectionContract | DefinitionTypes[keyof DefinitionTypes] =
    BindingTarget<"unit">,
  T extends BindingValue<P> = BindingValue<P>,
>(options: Declaration<R, T> & ProviderOptions & { readonly provides: P }): UnitBinding<T, NoInfer<R>, P>;

function createUnit<const R extends Requirements = NoRequirements, T = unknown>(
  options: Declaration<R, T> & ProviderOptions & { readonly provides?: never },
): Provider<T, ResolvedReferences<R>, "unit", NoInfer<R>>;

function createUnit(
  options: Declaration<Requirements, unknown> & ProviderOptions & { readonly provides?: Definition },
) {
  return defineProvider("unit", options);
}

/**
 * A reference without an implementation of its own: something must bind it through provides, a plug or override().
 * Integrations declare their contracts the same way, with their lifetime.
 */
function unitContract<T>(options: { readonly lifetime?: Lifetime } = {}): UnitContract<T> {
  return Object.freeze({
    ...createUnit({
      ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }),
      // The application never builds an unbound contract; it reports the missing implementation instead.
      factory: (): T => {
        throw new Error("An unbound unit contract cannot be constructed.");
      },
    }),
    required: true as const,
  });
}

/** Native construction and implementation-free references share the same binding mechanism. */
export const unit: typeof createUnit & { readonly contract: typeof unitContract } = Object.freeze(
  Object.assign(createUnit, { contract: unitContract }),
);

/**
 * A managed value: initialize(dependencies, { signal }) acquires it, and the handle's release() releases it.
 * Pass the signal to the native acquisition so a cancelled startup or scope stops waiting for it.
 * A singleton that leads to an execution, such as a server, is acquired after singletons and released before
 * execution scopes drain, so it stops bringing work in while everything that work needs is still available.
 */
export function resource<
  const R extends Requirements = NoRequirements,
  const P extends BindingTarget<"resource"> = BindingTarget<"resource">,
  T extends Resolved<P> = Resolved<P>,
>(
  options: RequirementsOptions<R> &
    ResourceOptions & {
      readonly provides: P;
      readonly initialize: (
        dependencies: ResolvedReferences<R>,
        options: CancellationOptions,
      ) => Promise<ResourceHandle<T>>;
    },
): Provider<ManagedResource<T>, ResolvedReferences<R>, "resource", NoInfer<R>>;

export function resource<const R extends Requirements = NoRequirements, T = unknown>(
  options: RequirementsOptions<R> &
    ResourceOptions & {
      readonly provides?: never;
      readonly initialize: (
        dependencies: ResolvedReferences<R>,
        options: CancellationOptions,
      ) => Promise<ResourceHandle<T>>;
    },
): Provider<ManagedResource<T>, ResolvedReferences<R>, "resource", NoInfer<R>>;

export function resource(
  options: RequirementsOptions<Requirements> &
    ResourceOptions & {
      readonly provides?: Definition;
      readonly initialize: (
        dependencies: ResolvedReferences<Requirements>,
        options: CancellationOptions,
      ) => Promise<ResourceHandle<unknown>>;
    },
) {
  const { initialize, requirements, lifetime, provides, whenAvailable } = options;

  if (typeof initialize !== "function") {
    throw new TypeError("resource() requires initialize().");
  }

  return defineProvider("resource", {
    requirements: requirements === undefined ? {} : requirements,
    ...(lifetime === undefined ? {} : { lifetime }),
    ...(provides === undefined ? {} : { provides }),
    ...(whenAvailable === undefined ? {} : { whenAvailable }),
    factory: (dependencies: ResolvedReferences<Requirements>): ManagedResource<unknown> => ({
      initialize: (initializeOptions) => initialize(dependencies, initializeOptions),
    }),
  });
}

/** An application lifecycle step, selected by defineApplication({ startupTasks, shutdownTasks }). */
export function hook<const R extends Requirements = NoRequirements>(
  options: RequirementsOptions<R> &
    Omit<ProviderOptions, "lifetime"> & {
      readonly provides?: BindingTarget<"hook">;
      readonly run: (dependencies: ResolvedReferences<R>, options: CancellationOptions) => void | Promise<void>;
      readonly lifetime?: never;
    },
): Provider<ApplicationHook, ResolvedReferences<R>, "hook", NoInfer<R>> {
  const { run, requirements, provides, whenAvailable, lifetime } = options;

  if (typeof run !== "function") {
    throw new TypeError("hook() requires run().");
  }

  // The shared construction path enforces the singleton lifetime of every hook.
  return defineProvider("hook", {
    ...(lifetime === undefined ? {} : { lifetime }),
    ...(requirements === undefined ? {} : { requirements }),
    ...(provides === undefined ? {} : { provides }),
    ...(whenAvailable === undefined ? {} : { whenAvailable }),
    factory: (dependencies: ResolvedReferences<R>): ApplicationHook => ({
      run: (options) => run(dependencies, options),
    }),
  } as Declaration<R, ApplicationHook> & ProviderOptions & { readonly provides?: AnyProvider });
}

export function isCollectionContract(value: unknown): value is CollectionContract {
  return isProvider(value) && value.gathers === true;
}

export function isProvider(value: unknown): value is AnyProvider {
  return (
    hasMarker(value, ProviderMarker) &&
    "factory" in value &&
    typeof value.factory === "function" &&
    "requirements" in value &&
    typeof value.requirements === "object" &&
    value.requirements !== null &&
    "kind" in value &&
    ["unit", "resource", "hook", "collection"].includes(String(value.kind))
  );
}
