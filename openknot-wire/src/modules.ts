import type { Decoration } from "./decorations.ts";
import type { EntriesGraph, GivesOf, GivesOfGraph, Graph, RootsOfGraph, SourceEntries } from "./graph.ts";
import { hasMarker } from "./internal/marker.ts";
import type { CollectionContract, Definition, Provider, Resolved } from "./providers.ts";
import { isProvider, ProviderMarker } from "./providers.ts";

const SelectionMarker = Symbol.for("@openknot-ts/wire/selection");
const DeferredMarker = Symbol.for("@openknot-ts/wire/deferred-module");

export type CompositionSource<D extends object> =
  | D
  | Readonly<Record<string, D>>
  | (() => PromiseLike<Readonly<Record<string, D>>>);

/**
 * Checks sources after inference, so inline factories retain their defaults. A primitive that can also be called as
 * `x<Types>()` makes TypeScript try an inline `x({ ... })` with Sources still unresolved, so that attempt must pass
 * for the inferred list to be checked at all.
 */
export type CheckedSources<Sources extends readonly unknown[], Source> = readonly unknown[] extends Sources
  ? unknown
  : Sources extends readonly Source[]
    ? unknown
    : never;

export type ModuleExports = Readonly<Record<string, unknown>>;

/** The module a provision returns: its graph follows the provided sources, with compositions expanded. */
export type SourceModule<Sources extends readonly unknown[]> = DeferredModule<
  RootsOfGraph<EntriesGraph<SourceEntries<Sources[number]>>>,
  GivesOfGraph<EntriesGraph<SourceEntries<Sources[number]>>>
>;

export type ModuleInput<R = any, G = any> = ModuleSelection<R, G> | DeferredModule<R, G>;
export type Exclusion = Definition | Decoration | ModuleInput;
/** Contracts an exclusion removes: excluded contracts, their bindings and excluded modules' implementations. */
type ExcludedGives<X> = X | GivesOf<X> | GivesOfGraph<X>;

interface ModuleLoadContext {
  load(module: ModuleInput): Promise<ModuleSelection>;
}

/** The same module kind with another graph: selectors keep immediate and deferred modules apart. */
type Rebuild<M, R, G> = M extends { readonly kind: "deferred-module" } ? DeferredModule<R, G> : ModuleSelection<R, G>;
/** Excluding a deferred module defers an immediate selection, as at runtime. */
type Excluded<M, X, R, G> = M extends { readonly kind: "deferred-module" }
  ? DeferredModule<R, G>
  : [X] extends [Definition | ModuleSelection]
    ? ModuleSelection<R, G>
    : ModuleInput<R, G>;

/**
 * Selectors declared once for every module kind, so a union of kinds stays callable while each kind
 * keeps its own result type through `this`.
 */
export interface ModuleSelectors<R = any, G = any> extends Graph<R, G> {
  includeOnly<const P extends readonly Definition[]>(providers: P): Rebuild<this, P[number], G>;
  exclude<const X extends readonly Exclusion[]>(
    items: X,
  ): Excluded<this, X[number], R, Exclude<G, ExcludedGives<X[number]>>>;
  when<const B extends boolean>(enabled: B): B extends false ? Rebuild<this, never, never> : Rebuild<this, R, G>;
  requiredBy<const M extends readonly ModuleInput[]>(
    ...roots: M
  ): Activation<RootsOfGraph<M[number]>, G | GivesOfGraph<M[number]>>;
}

/** Lazy module source; bootstrap materializes it once per application. */
export interface DeferredModule<R = any, G = any> extends ModuleSelectors<R, G> {
  readonly [DeferredMarker]: true;
  readonly kind: "deferred-module";
  load(context: ModuleLoadContext): Promise<ModuleSelection>;
}

export interface ModuleSelection<R = any, G = any> extends ModuleSelectors<R, G> {
  readonly [SelectionMarker]: true;
  readonly definitions: readonly object[];
  readonly roots: readonly Definition[];
  readonly implicitRoots: readonly Definition[];
  readonly excluded: readonly Definition[];
  /** Export names of the listed definitions, for diagnostics only; the first name wins. */
  readonly names: ReadonlyMap<object, string>;
}

/** Selected modules: roots contribute their definitions' needs, every selection contributes implementations. */
export interface Activation<R = any, G = any> extends Graph<R, G> {
  readonly selections: readonly ModuleInput[];
  readonly rootSelections: readonly ModuleInput[];
}

export interface ModuleDefinition {
  readonly providers?: ModuleExports | readonly ModuleExports[];
  readonly modules?: readonly ModuleInput[];
}

type SelectionTransform = (selection: ModuleSelection) => ModuleSelection;
type ResolvedExclusion = Definition | Decoration | ModuleSelection;

/** One selector implementation; projection decides immediate or deferred application. */
function moduleSelectors<M extends ModuleInput>(current: () => M, project: (transform: SelectionTransform) => M) {
  function exclude(items: readonly ResolvedExclusion[]): M;
  function exclude(items: readonly Exclusion[]): M | DeferredModule;
  function exclude(items: readonly Exclusion[]): M | DeferredModule {
    const snapshot = Object.freeze([...items]);

    if (!snapshot.some(isDeferredModule)) {
      return project((selection) => excludeSelection(selection, snapshot as readonly ResolvedExclusion[]));
    }

    return deferModule(async (context) => {
      const source: ModuleInput = current();
      const [selection, excluded] = await Promise.all([
        isDeferredModule(source) ? context.load(source) : source,
        Promise.all(snapshot.map((item) => (isDeferredModule(item) ? context.load(item) : item))),
      ]);
      return excludeSelection(selection, excluded);
    });
  }

  return {
    includeOnly(providers: readonly Definition[]): M {
      const snapshot = Object.freeze([...providers]);
      return project((selection) => {
        const listed = new Set(selection.definitions);
        for (const provider of snapshot) {
          if (!listed.has(provider)) {
            throw new Error("includeOnly references a provider outside this module selection.");
          }
        }
        return moduleSelection(selection.definitions, snapshot, selection.excluded, [], selection.names);
      });
    },
    exclude,
    when(enabled: boolean): M {
      return enabled
        ? current()
        : project((selection) =>
            moduleSelection([], [], [...selection.excluded, ...(selection.definitions as readonly Definition[])]),
          );
    },
    requiredBy(...roots: readonly ModuleInput[]): Activation {
      const activation = requiredBy(...roots);
      return Object.freeze({
        selections: Object.freeze([current(), ...activation.selections]),
        rootSelections: activation.rootSelections,
      }) as Activation;
    },
  };
}

function excludeSelection(selection: ModuleSelection, items: readonly ResolvedExclusion[]): ModuleSelection {
  const removed = new Set<Definition>();

  for (const item of items) {
    if (isModuleSelection(item)) {
      for (const definition of item.definitions) {
        removed.add(definition as Definition);
      }
      for (const provider of item.excluded) {
        removed.add(provider);
      }
    } else if ((typeof item === "object" && item !== null) || typeof item === "function") {
      removed.add(item as Definition);
    } else {
      throw new TypeError("exclude expects provider or module references.");
    }
  }

  return moduleSelection(
    selection.definitions.filter((definition) => !removed.has(definition as Definition)),
    selection.roots.filter((provider) => !removed.has(provider)),
    [...selection.excluded, ...removed],
    selection.implicitRoots.filter((provider) => !removed.has(provider)),
    selection.names,
  );
}

export function moduleSelection(
  definitions: readonly object[],
  roots: readonly Definition[],
  excluded: readonly Definition[],
  implicitRoots: readonly Definition[] = [],
  names: ReadonlyMap<object, string> = new Map(),
): ModuleSelection {
  // The compile-time graph exists only in types.
  const view: ModuleSelection = Object.freeze({
    [SelectionMarker]: true as const,
    definitions: Object.freeze([...definitions]),
    roots: Object.freeze([...new Set(roots)]),
    implicitRoots: Object.freeze([...new Set(implicitRoots)]),
    excluded: Object.freeze([...new Set(excluded)]),
    names,
    ...moduleSelectors<ModuleSelection>(
      () => view,
      (transform) => transform(view),
    ),
  }) as ModuleSelection;
  return view;
}

export function isModuleSelection(value: unknown): value is ModuleSelection {
  return hasMarker(value, SelectionMarker);
}

interface SourceModuleDefinition<D extends object> {
  readonly sources: readonly CompositionSource<D>[];
  readonly accepts: (value: unknown) => boolean;
  readonly label: string;
  readonly members?: (value: D) => readonly Definition[];
}

/** Shared module composer; layer providers add their own source restrictions. */
type ProviderEntries<P> = P extends readonly (infer Namespace)[] ? Namespace[keyof Namespace] : P[keyof P];
type ComposedRoots<P, M> = RootsOfGraph<EntriesGraph<ProviderEntries<P>>> | RootsOfGraph<M>;
type ComposedGives<P, M> = GivesOfGraph<EntriesGraph<ProviderEntries<P>>> | GivesOfGraph<M>;

export function composeModule<D extends object>(definition: SourceModuleDefinition<D>): DeferredModule;

export function composeModule<
  const P extends ModuleExports | readonly ModuleExports[] = {},
  const M extends readonly ModuleSelection[] = [],
>(definition: {
  readonly providers?: P;
  readonly modules?: M;
}): ModuleSelection<ComposedRoots<P, M[number]>, ComposedGives<P, M[number]>>;

export function composeModule<
  const P extends ModuleExports | readonly ModuleExports[] = {},
  const M extends readonly ModuleInput[] = [],
>(definition: {
  readonly providers?: P;
  readonly modules?: M;
}): ModuleInput<ComposedRoots<P, M[number]>, ComposedGives<P, M[number]>>;

export function composeModule<D extends object>(definition: ModuleDefinition | SourceModuleDefinition<D>): ModuleInput {
  if ("sources" in definition) {
    if ("providers" in definition || "modules" in definition) {
      throw new TypeError("composeModule() accepts either sources or providers/modules.");
    }
    return composeSources(definition);
  }

  if (definition.modules?.some(isDeferredModule)) {
    const providers = Array.isArray(definition.providers)
      ? definition.providers.map((namespace) => Object.freeze({ ...namespace }))
      : definition.providers === undefined
        ? undefined
        : Object.freeze({ ...definition.providers });
    const modules = Object.freeze([...(definition.modules ?? [])]);
    return deferModule(async (context) =>
      composeModule({
        ...(providers === undefined ? {} : { providers }),
        modules: await Promise.all(modules.map((module) => (isDeferredModule(module) ? context.load(module) : module))),
      }),
    );
  }

  const exportsList = Array.isArray(definition.providers)
    ? (definition.providers as readonly ModuleExports[])
    : definition.providers
      ? [definition.providers as ModuleExports]
      : [];

  const definitions: object[] = [];
  const excluded: Definition[] = [];
  const names = new Map<object, string>();

  for (const namespace of exportsList) {
    for (const [name, value] of Object.entries(namespace)) {
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        definitions.push(value);

        if (!names.has(value)) {
          names.set(value, name);
        }
      }
    }
  }

  const roots: Definition[] = definitions
    .filter((provider) => isProvider(provider) && (provider.kind === "unit" || provider.kind === "collection"))
    .map((provider) => provider as Definition);

  const implicitRoots = definitions.map((provider) => provider as Definition);

  for (const module of definition.modules ?? []) {
    if (!isModuleSelection(module)) {
      throw new TypeError("Expected a composeModule() selection. Compose modules through ordinary imports.");
    }

    definitions.push(...module.definitions);
    roots.push(...module.roots);
    implicitRoots.push(...module.implicitRoots);
    excluded.push(...module.excluded);

    for (const [definition, name] of module.names) {
      if (!names.has(definition)) {
        names.set(definition, name);
      }
    }
  }

  return moduleSelection(definitions, roots, excluded, implicitRoots, names);
}

/** Select activation roots; all available definitions can still be dependencies. */
export function requiredBy<const R extends readonly ModuleInput[]>(
  ...selections: R
): Activation<RootsOfGraph<R[number]>, GivesOfGraph<R[number]>> {
  const snapshot = Object.freeze([...selections]);
  return Object.freeze({ selections: snapshot, rootSelections: snapshot }) as Activation;
}

export interface CollectionProvider extends Provider<readonly unknown[], never, "collection"> {
  readonly members: readonly Definition[];
}

export function collectMembers<const P extends readonly Definition[]>(
  ...providers: P
): Provider<readonly Resolved<P[number]>[], never, "collection"> & {
  readonly members: P;
} {
  return Object.freeze({
    [ProviderMarker]: true as const,
    kind: "collection" as const,
    factory: (): readonly Resolved<P[number]>[] => {
      throw new Error("Collections are resolved by the application.");
    },
    lifetime: "singleton" as const,
    requirements: Object.freeze({}),
    members: Object.freeze([...providers]) as unknown as P,
  });
}

/** Units join it with `unit({ provides: contract, ... })`; it resolves to their values, or to an empty array. */
function collectionContract<T>(): CollectionContract<T> {
  return Object.freeze({ ...collectMembers(), gathers: true as const }) as CollectionContract<T>;
}

/** `collect.contract<T>()` gathers the units that declare it. */
export const collect: { readonly contract: typeof collectionContract } = Object.freeze({
  contract: collectionContract,
});

export function isDeferredModule(value: unknown): value is DeferredModule {
  return hasMarker(value, DeferredMarker);
}

/** Deferred modules use the same selectors after materialization. */
export function deferModule(load: (context: ModuleLoadContext) => Promise<ModuleSelection>): DeferredModule {
  const view: DeferredModule = Object.freeze({
    [DeferredMarker]: true as const,
    kind: "deferred-module" as const,
    load,
    ...moduleSelectors<DeferredModule>(
      () => view,
      (transform) => deferModule(async (context) => transform(await context.load(view))),
    ),
  }) as DeferredModule;
  return view;
}

/** Compose explicit definitions and native import loaders using the layer policy. */
function composeSources<D extends object>(options: SourceModuleDefinition<D>): DeferredModule {
  const accepts = options.accepts;
  const membersOf = options.members;
  const label = options.label;

  if (!Array.isArray(options.sources)) {
    throw new TypeError(`${label} expects an array of definitions or import loaders.`);
  }

  const sources = Object.freeze(
    options.sources.map((source) => {
      if (accepts(source) || typeof source === "function") {
        return source;
      }

      if (typeof source !== "object" || source === null || Array.isArray(source)) {
        throw new TypeError(`${label} received an invalid source.`);
      }

      const kind: unknown = Reflect.get(source, "kind");

      if (typeof kind === "string") {
        const contract = Reflect.get(source, "required") === true ? " contract" : "";
        throw new TypeError(`${label} does not accept a ${kind}${contract}.`);
      }

      for (const [name, value] of Object.entries(source)) {
        if (!accepts(value)) {
          throw new TypeError(`${label} received an invalid export '${name}'.`);
        }
      }

      return Object.freeze({ ...source });
    }),
  );

  return deferModule(async () => {
    const definitions: object[] = [];
    const names = new Map<object, string>();

    function add(value: unknown, key?: string): void {
      if (!accepts(value)) {
        throw new TypeError(`${label} received an invalid export '${key ?? "<definition>"}'.`);
      }

      const definition = value as D;
      const members = membersOf?.(definition);

      if (members !== undefined) {
        for (const provider of members) {
          definitions.push(provider);
        }
      } else {
        definitions.push(definition);
        if (key !== undefined && !names.has(definition)) {
          names.set(definition, key);
        }
      }
    }

    for (const source of sources) {
      const value: unknown = typeof source === "function" ? await source() : source;
      if (accepts(value)) {
        add(value);
      } else {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new TypeError(`${label} expects a module namespace from an import loader.`);
        }
        for (const [name, definition] of Object.entries(value)) {
          add(definition, name);
        }
      }
    }
    return moduleSelection(definitions, [], [], definitions as readonly Definition[], names);
  });
}
