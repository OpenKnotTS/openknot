import type { Definition, Lifetime } from "../providers.ts";
import type { ResolvedGraph } from "./composition.ts";

/** A resource to acquire and the resources of the same acquisition it waits for. */
export interface AcquisitionStep {
  readonly key: object;
  readonly after: readonly object[];
}

/** What opens when: the acquisition plans of resources and intake, and the singletons built around them. */
export function planAcquisitions(
  graph: ResolvedGraph,
  input: {
    readonly paths: ReadonlyMap<object, readonly string[]>;
    readonly resourceOrder: readonly Definition[];
    readonly serviceRoots: readonly Definition[];
  },
) {
  const { keyFor, providers, overrides, edges, deferred, wrapperEdges, definitions } = graph;
  const { paths } = input;

  // Resources need no list: every one the application reaches is acquired, singletons once at startup and
  // scoped ones for each scope. Each waits only for what it must: the resources it depends on, even through
  // other definitions, and the resources resourceOrder puts before it. Everything else is acquired in parallel.
  /** The resources a definition reaches, stopping at each one, whose own dependencies come with it. */
  function nearestResources(identity: object, visited = new Set<object>()): object[] {
    const found: object[] = [];

    for (const edge of [...(edges.get(identity) ?? []), ...wrapperEdges(identity)]) {
      const dependency = edge.identity;

      if (dependency === undefined || visited.has(dependency)) {
        continue;
      }

      visited.add(dependency);

      // An override supplies the value: nothing is acquired for it or on its behalf.
      if (overrides.has(dependency)) {
        continue;
      }

      if (providers.get(dependency)?.kind === "resource") {
        found.push(dependency);
      } else {
        found.push(...nearestResources(dependency, visited));
      }
    }
    return found;
  }
  /** For each resource of a set, the resources of the same set it must wait for. */
  function acquisitionPlan(members: readonly object[], first: readonly object[] = []): readonly AcquisitionStep[] {
    const included = new Set(members);
    const after = new Map(
      members.map((member) => [member, nearestResources(member).filter((dependency) => included.has(dependency))]),
    );

    // resourceOrder: each listed resource, with what it needs and nothing acquired before, one after another;
    // every other resource waits for the last of them. A listed resource that an earlier one already needs is
    // acquired in that one's group, so each group is headed by the listed resource that opened it, which completes
    // after everything in its group.
    const heads: object[] = [];
    const groups = new Map<object, number>();

    for (const resource of first) {
      if (!included.has(resource) || groups.has(resource)) {
        continue;
      }

      const index = heads.push(resource) - 1;
      const pending = [resource];

      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (groups.has(next)) {
          continue;
        }

        groups.set(next, index);
        pending.push(...(after.get(next) ?? []));
      }
    }

    return members.map((key) => {
      const group = groups.get(key);
      const barrier = group === undefined ? heads.at(-1) : group > 0 ? heads[group - 1] : undefined;
      const waits = after.get(key) ?? [];
      return { key, after: barrier === undefined || waits.includes(barrier) ? waits : [...waits, barrier] };
    });
  }

  function acquired(lifetime: Lifetime): object[] {
    return [...paths.keys()].filter((identity) => {
      const provider = providers.get(identity);
      return provider?.kind === "resource" && provider.lifetime === lifetime && !overrides.has(identity);
    });
  }

  const firstKeys = input.resourceOrder.map((reference) => keyFor(reference));

  /** Whether a definition leads, through what it is built with, to something that opens execution scopes. */
  function reachesExecution(identity: object, visited = new Set<object>()): boolean {
    return [...(edges.get(identity) ?? []), ...wrapperEdges(identity)].some(({ identity: dependency }) => {
      if (dependency === undefined || visited.has(dependency) || overrides.has(dependency)) {
        return false;
      }

      visited.add(dependency);
      return definitions.get(dependency)?.opensScope === true || reachesExecution(dependency, visited);
    });
  }

  // Intake brings work into the application: it opens after singletons and closes before scopes drain, so work
  // never meets a closed dependency. Sources open before what else leads to an execution, such as a server, and
  // close after it, so a request still running can reach them, unless resourceOrder lists them otherwise. Each opens
  // alone, in that order and then in module order, and closes in reverse. A resource that depends on intake leads to
  // an execution itself, so ordinary resources never wait for it.
  const singletonResources = acquired("singleton");
  const isSource = (key: object): boolean => definitions.get(key)?.source === true;
  const intakeKeys = [
    ...singletonResources.filter(isSource),
    ...singletonResources.filter((key) => !isSource(key) && reachesExecution(key)),
  ];
  const intakeSet = new Set(intakeKeys);
  const resources = acquisitionPlan(
    singletonResources.filter((key) => !intakeSet.has(key)),
    firstKeys,
  );
  const intakeOrder = [...new Set([...firstKeys.filter((key) => intakeSet.has(key)), ...intakeKeys])];
  const intake = acquisitionPlan(intakeOrder, intakeOrder);
  const scopeResources = acquisitionPlan(acquired("scoped"), firstKeys);

  /**
   * A scope's own resource list: each through what builds it, once, with the scoped resources it depends on,
   * acquired in parallel by the same dependencies and in resourceOrder's order.
   */
  function scopeAcquisitionPlan(references: readonly Definition[]): readonly AcquisitionStep[] {
    const members = new Set<object>();
    const include = (key: object): void => {
      if (members.has(key) || overrides.has(key)) {
        return;
      }

      members.add(key);

      for (const dependency of nearestResources(key)) {
        if (providers.get(dependency)?.lifetime === "scoped") {
          include(dependency);
        }
      }
    };

    for (const reference of references) {
      include(keyFor(reference));
    }

    return acquisitionPlan([...members], firstKeys);
  }

  /**
   * The scoped resources an execution root may need, through every branch it may take: construction dependencies
   * and decorations, a bound optional dependency included, and the deferred references of everything that executes
   * in this scope. The root executes here; a definition that opens scopes of
   * its own acquires its deferred dependencies there. It predicts no branch; it leaves out what the root cannot reach.
   */
  function rootAcquisitionPlan(root: Definition): readonly AcquisitionStep[] {
    const rootKey = keyFor(root);
    const members: object[] = [];
    const visited = new Set<object>();
    const pending = [rootKey];

    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      if (visited.has(key) || overrides.has(key)) {
        continue;
      }

      visited.add(key);

      const provider = providers.get(key);

      if (provider?.kind === "resource" && provider.lifetime === "scoped") {
        members.push(key);
      }

      const ownScope = key !== rootKey && definitions.get(key)?.opensScope === true;

      for (const edge of [
        ...(edges.get(key) ?? []),
        ...wrapperEdges(key),
        ...(ownScope ? [] : (deferred.get(key) ?? [])),
      ]) {
        if (edge.identity !== undefined) {
          pending.push(edge.identity);
        }
      }
    }

    return acquisitionPlan(members, firstKeys);
  }

  // Every reachable singleton is built at startup, so a failing factory stops startup instead of a first call.
  const reachableSingletons = [...new Set([...input.serviceRoots.map(keyFor), ...paths.keys()])].filter((identity) => {
    const provider = providers.get(identity);
    return (
      provider?.lifetime === "singleton" &&
      (provider.kind === "unit" || provider.kind === "collection") &&
      // Listing a contract alone does not construct it; validation reports the ones something requires.
      !provider.required &&
      !overrides.has(identity)
    );
  });
  // A singleton built from an intake resource's value waits for it; all the others are ready before intake opens.
  const needsIntake = (identity: object): boolean => nearestResources(identity).some((key) => intakeSet.has(key));
  const startupSingletons = reachableSingletons.filter((identity) => !needsIntake(identity));
  const intakeSingletons = reachableSingletons.filter(needsIntake);

  return {
    resources,
    scopeResources,
    intake,
    scopeAcquisitionPlan,
    rootAcquisitionPlan,
    startupSingletons,
    intakeSingletons,
  };
}
