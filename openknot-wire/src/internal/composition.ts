import type { AdaptedDefinition, DefinitionAdapterContext } from "../adapters.ts";
import type { Decoration } from "../decorations.ts";
import { isDecoration } from "../decorations.ts";
import type { ApplicationDefinition, ValueOverride } from "../definition.ts";
import { applicationStatus } from "../definition.ts";
import { isOptionalDependency } from "../dependencies.ts";
import type { CollectionProvider, ModuleInput, ModuleSelection } from "../modules.ts";
import { composeModule, isDeferredModule } from "../modules.ts";
import type { AnyProvider, Definition, Lifetime, Requirements } from "../providers.ts";
import { isProvider, unit } from "../providers.ts";
import { composeDefinitions, createDefinitionResolver } from "./definitions.ts";
import { loadDefinitionAdapters } from "./integrations.ts";
import { planAcquisitions } from "./plans.ts";
import { validateGraph } from "./validation.ts";

export function kindOf(definition: object): string {
  const kind: unknown = Reflect.get(definition, "kind");
  return typeof kind === "string" ? kind : "definition";
}

export function unavailable(): Error {
  return new Error("Dependency definition is unavailable, explicitly excluded, or has no configured adapter.");
}

/** A dependency edge, resolved once: its requirement name, the reference as declared and its identity. */
export interface Edge {
  readonly name: string;
  readonly reference: Definition;
  readonly identity: object | undefined;
  readonly optional: boolean;
  /** Not named in requirements, such as a collection member or a deferred reference. */
  readonly unnamed?: true;
}

/** One decoration of a target, with its resolved requirement edges. */
export interface Wrapper {
  readonly decoration: Decoration;
  readonly edges: readonly Edge[];
}

/** What composition resolved once, and validation, planning and construction read. */
export interface ResolvedGraph {
  readonly keys: ReadonlyMap<object, object>;
  readonly keyFor: (provider: object) => object;
  readonly providers: ReadonlyMap<object, AnyProvider>;
  readonly overrides: ReadonlyMap<object, unknown>;
  readonly edges: ReadonlyMap<object, readonly Edge[]>;
  readonly deferred: ReadonlyMap<object, readonly Edge[]>;
  readonly wrapperEdges: (identity: object) => readonly Edge[];
  readonly definitions: ReadonlyMap<object, AdaptedDefinition>;
}

/** The requirements a definition declared, which also name its deferred references. */
export function declaredRequirements(definition: object): Requirements {
  const declared: unknown = Reflect.get(definition, "requirements");
  return typeof declared === "object" && declared !== null ? (declared as Requirements) : {};
}

export function invalidDependencies(problems: readonly string[], unbound: boolean): Error {
  return new Error(
    `Invalid application dependencies:\n${problems.join("\n")}` +
      (unbound ? "\nBind each contract with a plug or provides, or supply it through override()." : ""),
  );
}

/** Everything resolution and description need, composed without starting anything. */
export async function composeApplication(
  definition: ApplicationDefinition,
  overrideItems: readonly ValueOverride[],
  context: DefinitionAdapterContext,
  signal: AbortSignal | undefined,
) {
  const options = definition.options;
  const requested = options.modules;
  const modules = new Map<ModuleInput, Promise<ModuleSelection>>();

  function materialize(module: ModuleInput): Promise<ModuleSelection> {
    let pending = modules.get(module);

    if (pending === undefined) {
      pending = isDeferredModule(module)
        ? Promise.resolve().then(() => module.load({ load: materialize }))
        : Promise.resolve(module);
      modules.set(module, pending);
    }

    return pending;
  }

  const [selected, roots] = await Promise.all([
    Promise.all(requested.selections.map(materialize)),
    Promise.all(requested.rootSelections.map(materialize)),
  ]);

  signal?.throwIfAborted();

  const activationRoots = [...new Set(roots.flatMap((selection) => selection.roots))];

  // Everything the root modules list, in module order: validation starts here.
  const listedRoots = [...new Set(roots.flatMap((selection) => [...selection.roots, ...selection.implicitRoots]))];

  const selections = [
    ...selected,
    // Lifecycle tasks and the application's own status are always available, without being roots.
    composeModule({
      providers: [
        { applicationStatus },
        ...options.startupTasks.map((task) => ({ task })),
        ...options.shutdownTasks.map((task) => ({ task })),
      ],
    }),
  ];

  // The decorations the root modules list, in their order; a hard exclusion removes one like any definition.
  const excludedEntries = new Set<object>(selected.flatMap((selection) => selection.excluded));
  const decorations = [...new Set(roots.flatMap((selection) => selection.definitions))].filter(
    (entry): entry is Decoration => isDecoration(entry) && !excludedEntries.has(entry),
  );

  // Decoration requirements enter the graph without registering another root.
  const carriers = decorations.map((decoration) =>
    unit({ requirements: decoration.requirements, factory: (dependencies) => dependencies }),
  );

  const adapters = await loadDefinitionAdapters(selections, carriers);
  const adapt = createDefinitionResolver(adapters, context);

  const { keys, providers, definitions, sources, inactive, conflicts } = composeDefinitions(
    selections,
    adapt,
    carriers,
    {
      values: overrideItems.map((item) => item.target),
      listed: roots.flatMap((selection) => selection.definitions),
    },
  );

  // Export names make diagnostics readable; definitions listed in arrays are named by their kind only.
  const exportNames = new Map<object, string>();

  for (const selection of selected) {
    for (const [definition, name] of selection.names) {
      if (!exportNames.has(definition)) {
        exportNames.set(definition, name);
      }
    }
  }

  function labelOf(definition: object): string {
    const name = exportNames.get(definition);
    return name === undefined ? kindOf(definition) : `${kindOf(definition)} '${name}'`;
  }

  function keyFor(provider: object): object {
    const key = keys.get(provider);
    if (key === undefined) {
      throw unavailable();
    }
    return key;
  }

  // Composition conflicts are reported together with the graph's other problems, and the item is skipped.
  const problems: string[] = [];

  for (const reference of conflicts) {
    problems.push(`- multiple implementations supplied for ${labelOf(reference)}`);
  }

  // A provider target checked its binding when declared; an integration's reference can only now.
  for (const [reference, source] of sources) {
    const own = isProvider(reference) ? undefined : adapt(reference)?.provider;

    if (own !== undefined && isProvider(source) && (own.kind !== source.kind || own.lifetime !== source.lifetime)) {
      problems.push(`- a binding of ${labelOf(reference)} must preserve its kind and lifetime`);
    }
  }

  const overrides = new Map<object, unknown>();

  for (const item of overrideItems) {
    const key = keys.get(item.target);

    if (key === undefined) {
      problems.push(`- override target ${labelOf(item.target)} is unavailable or excluded`);
    } else if (overrides.has(key)) {
      problems.push(`- duplicate override for ${labelOf(key)}`);
    } else {
      overrides.set(key, item.value);
    }
  }

  function selectedReferences<P extends Definition>(references: readonly P[]): P[] {
    const seen = new Set<object>();
    return references.filter((reference) => {
      if (inactive.has(reference)) {
        return false;
      }

      const key = keyFor(reference);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  /**
   * A lifecycle list without what no module provides or what has the wrong kind and lifetime. Composition
   * reports every such entry; a scope's own resource list fails on its first.
   */
  function lifecycleList<P extends Definition>(
    list: string,
    references: readonly P[],
    kind: string,
    lifetime: Lifetime | undefined,
    report: (problem: string) => void = (problem) => problems.push(`- ${problem}`),
  ): P[] {
    return selectedReferences(
      references.filter((reference) => {
        const key = keys.get(reference);
        const provider = key === undefined ? undefined : providers.get(key);
        const fits = provider?.kind === kind && (lifetime === undefined || provider.lifetime === lifetime);

        if (inactive.has(reference) || fits) {
          return true;
        }

        report(
          provider === undefined
            ? `${list} lists a ${labelOf(reference)} that no selected module provides`
            : `${list} needs a ${lifetime === undefined ? "" : `${lifetime} `}${kind}, not the ${provider.lifetime} ${labelOf(reference)}`,
        );

        return false;
      }),
    );
  }

  const startupTasks = lifecycleList("startupTasks", options.startupTasks, "hook", "singleton");
  const shutdownTasks = lifecycleList("shutdownTasks", options.shutdownTasks, "hook", "singleton");
  const resourceOrder = lifecycleList("resourceOrder", options.resourceOrder, "resource", undefined);

  /** The kind of a reference, if it is registered. */
  function registeredKind(reference: Definition): string | undefined {
    const key = keys.get(reference);
    return key === undefined ? undefined : providers.get(key)?.kind;
  }

  const serviceRoots = selectedReferences(
    activationRoots.filter((reference) => {
      // Resources are acquired in their own phases.
      if (inactive.has(reference) || registeredKind(reference) === "resource") {
        return false;
      }

      const key = keys.get(reference);

      if (key === undefined) {
        problems.push(
          `- the root ${labelOf(reference)} is unavailable, explicitly excluded, or has no configured adapter`,
        );
        return false;
      }

      // A root is validated with what it needs; its lifetime decides when it is built, as for any dependency.
      const kind = providers.get(key)?.kind;
      if (kind !== "unit" && kind !== "collection") {
        problems.push(
          `- application roots are units or collections, not the ${labelOf(reference)}: select lifecycle providers in their phase`,
        );
        return false;
      }

      return true;
    }),
  );

  // Every dependency edge is resolved once, before anything resolves: construction, validation, lifetimes,
  // cycles and the description share them.
  /** The definition whose requirements name a key's dependencies: the chosen binding. */
  function declaringDefinition(identity: object): object {
    return sources.get(identity) ?? identity;
  }

  /**
   * A contract without an implementation is absent for optional consumers, exactly like an unregistered one.
   */
  function optionalIdentity(reference: Definition): object | undefined {
    const identity = keys.get(reference);

    if (identity === undefined) {
      return undefined;
    }

    return overrides.has(identity) || !providers.get(identity)?.required ? identity : undefined;
  }

  function requirementEdges(requirements: Requirements): readonly Edge[] {
    return Object.entries(requirements).map(([name, requirement]) =>
      isOptionalDependency(requirement)
        ? { name, reference: requirement.reference, identity: optionalIdentity(requirement.reference), optional: true }
        : { name, reference: requirement, identity: keys.get(requirement), optional: false },
    );
  }

  /** An edge to a dependency nobody named in requirements, labelled by its export name or kind. */
  function unnamedEdge(reference: Definition): Edge {
    return {
      name: exportNames.get(reference) ?? kindOf(reference),
      reference,
      identity: keys.get(reference),
      optional: false,
      unnamed: true,
    };
  }

  const edges = new Map<object, readonly Edge[]>();
  const deferred = new Map<object, readonly Edge[]>();

  for (const [identity, provider] of providers) {
    edges.set(
      identity,
      provider.kind === "collection"
        ? (provider as CollectionProvider).members.map(unnamedEdge)
        : requirementEdges(provider.requirements),
    );

    // Deferred references keep the names their definition declared in its requirements.
    const references = (definitions.get(identity)?.references ?? []).filter(
      (reference) => !isOptionalDependency(reference),
    );

    if (references.length > 0) {
      const declared = requirementEdges(declaredRequirements(declaringDefinition(identity)));

      deferred.set(
        identity,
        references.map(
          (reference) =>
            declared.find((edge) => edge.reference === reference && !edge.optional) ?? unnamedEdge(reference),
        ),
      );
    }
  }

  // Decorations wrap one target each, in declaration order; overrides stay final values.
  const wrappers = new Map<object, Wrapper[]>();
  for (const decoration of decorations) {
    const identity = keys.get(decoration.target);

    if (identity === undefined) {
      problems.push(`- a decoration targets a ${labelOf(decoration.target)} that is unavailable or excluded`);
      continue;
    }

    const target = providers.get(identity) as AnyProvider;

    if (target.kind !== "unit") {
      problems.push(`- only units and contracts can be decorated, not the ${labelOf(identity)}`);
      continue;
    }

    const chain = wrappers.get(identity) ?? [];

    chain.push({ decoration, edges: requirementEdges(decoration.requirements) });
    wrappers.set(identity, chain);
  }

  function wrapperEdges(identity: object): readonly Edge[] {
    return overrides.has(identity) ? [] : (wrappers.get(identity) ?? []).flatMap((wrapper) => wrapper.edges);
  }

  const graph: ResolvedGraph = {
    keys,
    keyFor,
    providers,
    overrides,
    edges,
    deferred,
    wrapperEdges,
    definitions,
  };

  const { paths, unbound, configs } = validateGraph(graph, {
    starts: [...listedRoots, ...resourceOrder, ...startupTasks, ...shutdownTasks],
    provided: listedRoots.flatMap((reference) => adapt(reference)?.provides?.map((entry) => entry.reference) ?? []),
    inactive,
    labelOf,
    problems,
  });

  return {
    ...graph,
    ...planAcquisitions(graph, { paths, resourceOrder, serviceRoots }),
    declaringDefinition,
    wrappers,
    optionalIdentity,
    lifecycleList,
    startupTasks,
    shutdownTasks,
    listedRoots,
    configs,
    problems,
    unbound,
  };
}
