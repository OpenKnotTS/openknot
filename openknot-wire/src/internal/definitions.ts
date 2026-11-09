import type { AdaptedDefinition, DefinitionAdapter, DefinitionAdapterContext } from "../adapters.ts";
import { isOptionalDependency } from "../dependencies.ts";
import type { CollectionProvider, ModuleSelection } from "../modules.ts";
import { collectMembers } from "../modules.ts";
import { isPlug } from "../plug.ts";
import type { AnyProvider, Definition } from "../providers.ts";
import { isCollectionContract, isProvider } from "../providers.ts";

interface GraphConfiguration {
  readonly values?: readonly Definition[];
  /** Definitions the root modules list, in order: the only candidates for collection contracts. */
  readonly listed?: readonly object[];
}

/** An adapted definition's provider, identity reference and flags, which are either absent or `true`. */
function validShape(shape: {
  readonly provider: unknown;
  readonly reference: unknown;
  readonly opensScope?: unknown;
  readonly source?: unknown;
  readonly pure?: unknown;
}): boolean {
  return (
    isProvider(shape.provider) &&
    ((typeof shape.reference === "object" && shape.reference !== null) || typeof shape.reference === "function") &&
    [shape.opensScope, shape.source, shape.pure].every((flag) => flag === undefined || flag === true)
  );
}

export function createDefinitionResolver(adapters: readonly DefinitionAdapter[], context?: DefinitionAdapterContext) {
  const cache = new Map<object, AdaptedDefinition | undefined>();

  return (definition: object): AdaptedDefinition | undefined => {
    if (cache.has(definition)) {
      return cache.get(definition);
    }

    if (isProvider(definition)) {
      // A collection member keeps its own identity; any other binding is keyed by the contract it implements.
      const result = Object.freeze({
        reference: isCollectionContract(definition.provides) ? definition : (definition.provides ?? definition),
        provider: definition,
      });
      cache.set(definition, result);
      return result;
    }

    let match: AdaptedDefinition | undefined;

    for (const adapter of adapters) {
      const candidate = adapter.adapt(definition, context);
      if (candidate === undefined) {
        continue;
      }

      if (match !== undefined) {
        throw new Error("Multiple adapters recognize the same definition.");
      }

      if (!validShape(candidate)) {
        throw new TypeError(`Adapter '${adapter.name}' returned an invalid definition.`);
      }

      const provides = (candidate.provides ?? []).map((provided) => {
        if (!validShape(provided)) {
          throw new TypeError(`Adapter '${adapter.name}' returned an invalid provided definition.`);
        }
        return Object.freeze({ ...provided });
      });

      match = Object.freeze({
        ...candidate,
        references: Object.freeze([...(candidate.references ?? [])]),
        provides: Object.freeze(provides),
      });
    }

    cache.set(definition, match);
    return match;
  };
}

/** Canonical reference identity is independent of module export names: each group is keyed by its contract. */
export function composeDefinitions(
  selections: readonly ModuleSelection[],
  adapt: ReturnType<typeof createDefinitionResolver>,
  additional: readonly Definition[] = [],
  configuration: GraphConfiguration = {},
): {
  readonly keys: ReadonlyMap<object, object>;
  readonly providers: ReadonlyMap<object, AnyProvider>;
  readonly definitions: ReadonlyMap<object, AdaptedDefinition>;
  /** The definition each key was chosen from, which declared its requirements. */
  readonly sources: ReadonlyMap<object, object>;
  readonly inactive: ReadonlySet<object>;
  /** References bound by more than one implementation; the first one is kept. */
  readonly conflicts: readonly object[];
} {
  function adaptIncluded(definition: object): AdaptedDefinition | undefined {
    const result = adapt(definition);

    if (result === undefined && isPlug(definition)) {
      throw new TypeError("No port integration recognizes this plug");
    }

    return result;
  }

  const excluded = new Set<object>(
    selections
      .flatMap((view) => view.excluded)
      .map((reference) =>
        isProvider(reference) && reference.provides !== undefined
          ? reference
          : (adapt(reference)?.reference ?? reference),
      ),
  );

  interface Entry {
    readonly source: object;
    readonly adapted: AdaptedDefinition;
  }

  const groups = new Map<object, Entry[]>();
  const queue: AdaptedDefinition[] = [];
  const pending = new Map<object, { readonly adapted: AdaptedDefinition; readonly register: boolean }>();
  const configuredReferences = new Set(
    (configuration.values ?? []).map((reference) => adapt(reference)?.reference ?? reference),
  );

  function available(reference: Definition): boolean {
    if (excluded.has(reference)) {
      return false;
    }

    const canonical = adapt(reference)?.reference ?? reference;
    const group = groups.get(canonical);

    if (group === undefined || (reference !== canonical && !group.some(({ source }) => source === reference))) {
      return false;
    }
    return configuredReferences.has(canonical) || group.some(({ adapted }) => !adapted.provider.required);
  }

  function add(source: object, adapted: AdaptedDefinition, register = true): void {
    if (excluded.has(source) || excluded.has(adapted.reference)) {
      return;
    }

    if (adapted.provider.whenAvailable?.some((reference) => !available(reference))) {
      pending.set(source, { adapted, register });
      return;
    }

    pending.delete(source);

    if (!register) {
      queue.push({ ...adapted, provides: [] });
      return;
    }

    const group = groups.get(adapted.reference) ?? [];

    if (group.some((entry) => entry.source === source)) {
      return;
    }

    group.push({ source, adapted });
    groups.set(adapted.reference, group);
    queue.push(adapted);
  }

  for (const view of selections) {
    for (const definition of view.definitions) {
      const adapted = adaptIncluded(definition);

      if (adapted !== undefined) {
        add(definition, adapted);
      }
    }
  }

  // Decorations contribute dependencies without registering another root.
  for (const source of additional) {
    const adapted = adaptIncluded(source);

    if (adapted !== undefined) {
      add(source, adapted, false);
    }
  }

  const expanded = new Set<AnyProvider>();
  let index = 0;

  while (index < queue.length || pending.size > 0) {
    if (index === queue.length) {
      const ready = [...pending].filter(([, { adapted }]) => adapted.provider.whenAvailable?.every(available));
      if (ready.length === 0) {
        break;
      }
      for (const [source, { adapted, register }] of ready) {
        add(source, adapted, register);
      }
    }

    const current = queue[index];
    index++;

    if (current === undefined || expanded.has(current.provider)) {
      continue;
    }

    expanded.add(current.provider);

    for (const provided of current.provides ?? []) {
      add(provided.provider, provided);
    }

    const provider = current.provider;
    const dependencies = [
      ...Object.values(provider.requirements),
      ...(provider.kind === "collection" ? (provider as CollectionProvider).members : []),
      ...(current.references ?? []),
    ];

    for (const dependency of dependencies) {
      // An optional dependency never introduces a definition; the application's override or replacement of it does.
      const source = isOptionalDependency(dependency) ? dependency.reference : dependency;

      if (isOptionalDependency(dependency) && !configuredReferences.has(adapt(source)?.reference ?? source)) {
        continue;
      }

      const adapted = adaptIncluded(source);

      if (adapted !== undefined) {
        add(source, adapted);
      }
    }
  }

  const keys = new Map<object, object>();
  const providers = new Map<object, AnyProvider>();
  const definitions = new Map<object, AdaptedDefinition>();
  const sources = new Map<object, object>();
  const conflicts: object[] = [];

  for (const [reference, group] of groups) {
    // A reference's own declaration is its default, or a contract without one; a binding to it replaces it.
    const bindings = group.filter(({ source }) => source !== reference);
    if (bindings.length > 1) {
      conflicts.push(reference);
    }

    const chosen = bindings[0] ?? group[0];

    if (chosen === undefined) {
      continue;
    }

    providers.set(reference, chosen.adapted.provider);
    definitions.set(reference, chosen.adapted);
    sources.set(reference, chosen.source);
    keys.set(reference, reference);

    for (const { source } of group) {
      keys.set(source, reference);
    }
  }

  // A collection contract gathers the registered units that the root modules list, in their order;
  // exclusions and unmet conditions leave a unit unregistered, so it is no member.
  const members = new Map<object, Definition[]>();

  for (const definition of new Set(configuration.listed ?? [])) {
    if (!isProvider(definition) || !isCollectionContract(definition.provides) || !providers.has(definition)) {
      continue;
    }

    const listed = members.get(definition.provides);

    if (listed === undefined) {
      members.set(definition.provides, [definition]);
    } else {
      listed.push(definition);
    }
  }

  for (const [reference, adapted] of definitions) {
    if (!isCollectionContract(adapted.provider)) {
      continue;
    }

    const provider = collectMembers(...(members.get(reference) ?? []));
    providers.set(reference, provider);
    definitions.set(reference, Object.freeze({ ...adapted, provider }));
  }

  return {
    keys,
    providers,
    definitions,
    sources,
    inactive: new Set([...pending.keys()].filter((source) => !keys.has(source))),
    conflicts,
  };
}
