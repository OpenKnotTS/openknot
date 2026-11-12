import type { Config } from "../config.ts";
import { configVariables, isConfig } from "../config.ts";
import type { Definition } from "../providers.ts";
import type { Edge, ResolvedGraph } from "./composition.ts";
import { kindOf } from "./composition.ts";

/**
 * Checks the composed graph as a whole, reporting every problem together: what the roots reach must be bound,
 * singletons may not keep scoped values, and nothing may depend on itself.
 */
export function validateGraph(
  graph: ResolvedGraph,
  input: {
    readonly starts: readonly Definition[];
    readonly provided: readonly Definition[];
    readonly inactive: ReadonlySet<object>;
    readonly labelOf: (definition: object) => string;
    readonly problems: string[];
  },
) {
  const { keys, providers, overrides, edges, deferred, wrapperEdges } = graph;
  const { inactive, labelOf, problems } = input;

  // A contract required by anything reachable from the roots must be bound before any resource starts.
  interface Pending {
    readonly reference: Definition;
    readonly identity: object | undefined;
    readonly path: readonly string[];
    readonly subject: string;
  }

  let unbound = false;
  const paths = new Map<object, readonly string[]>();
  const visited = new Set<object>();
  const starting = (references: readonly Definition[]): Pending[] =>
    references
      .filter((reference) => keys.has(reference) && !inactive.has(reference))
      .map((reference): Pending => {
        const label = labelOf(reference);
        return { reference, identity: keys.get(reference), path: [label], subject: label };
      });

  const queue = starting(input.starts);

  // A listed definition contributes what it provides as well, so what those definitions need is validated too.
  // They are visited last, so a problem keeps the path from the definitions that use them.
  const provided = starting(input.provided);

  for (let index = 0; index < queue.length || provided.length > 0; index++) {
    if (index === queue.length) {
      queue.push(...provided.splice(0));
    }

    const { reference, identity: key, path, subject } = queue[index] as Pending;

    if (visited.has(key ?? reference)) {
      continue;
    }

    if (key === undefined) {
      visited.add(reference);
      unbound = true;
      problems.push(`- ${subject} is unavailable or excluded (${path.join(" → ")})`);
      continue;
    }

    // A contract only listed in a module fails no execution; it is checked where something requires it.
    if (providers.get(key)?.required && !overrides.has(key)) {
      if (path.length > 1) {
        visited.add(key);
        unbound = true;
        problems.push(`- ${subject} has no implementation (${path.join(" → ")})`);
      }
      continue;
    }

    visited.add(key);
    paths.set(key, path);

    if (overrides.has(key)) {
      continue;
    }

    for (const edge of [...(edges.get(key) ?? []), ...wrapperEdges(key), ...(deferred.get(key) ?? [])]) {
      // An optional dependency without a binding is absent; a bound one is validated and acquired like any other.
      if (edge.optional && edge.identity === undefined) {
        continue;
      }

      queue.push({
        reference: edge.reference,
        identity: edge.identity,
        path: [...path, edge.name],
        subject: edge.unnamed ? labelOf(edge.reference) : `${kindOf(edge.reference)} '${edge.name}'`,
      });
    }
  }

  // Lifetimes and cycles hold for every registered definition, including those resolved only on demand. A
  // transient is built anew for every resolution and kept by its consumer, so it changes no lifetime: a scoped
  // value may keep anything, and a singleton anything but a scoped value, also one a kept transient keeps.
  /** Reports the scoped values a singleton keeps through its construction dependencies, transients included. */
  function reportCapturedScoped(identity: object, owner: string, dependencies: readonly Edge[]): void {
    const via = paths.has(identity) ? ` (${paths.get(identity)?.join(" → ")})` : "";
    const seen = new Set<object>();

    const visit = (captured: readonly Edge[], through: readonly string[]): void => {
      for (const { name, identity: dependency } of captured) {
        if (dependency === undefined || seen.has(dependency)) {
          continue;
        }

        seen.add(dependency);
        const required = providers.get(dependency);

        if (required === undefined) {
          continue;
        }

        const label = `${required.lifetime} ${kindOf(dependency)} '${name}'`;

        if (required.lifetime === "scoped") {
          const chain = through.length === 0 ? "" : ` through ${through.join(" → ")}`;
          problems.push(`- ${owner} depends on ${label}${chain}, which has a shorter lifetime${via}`);
        } else if (required.lifetime === "transient" && !overrides.has(dependency)) {
          // An overridden transient is a value; any other is built with what it depends on.
          visit([...(edges.get(dependency) ?? []), ...wrapperEdges(dependency)], [...through, label]);
        }
      }
    };

    visit(dependencies, []);
  }

  for (const [identity, provider] of providers) {
    if (overrides.has(identity) || provider.lifetime !== "singleton") {
      continue;
    }

    reportCapturedScoped(identity, `singleton ${labelOf(identity)}`, edges.get(identity) ?? []);
    reportCapturedScoped(identity, `decoration of singleton ${labelOf(identity)}`, wrapperEdges(identity));
  }

  const states = new Map<object, "active" | "done">();
  const trail: { readonly identity: object; readonly label: string }[] = [];

  function visit(identity: object, label: string): void {
    const state = states.get(identity);

    if (state === "done") {
      return;
    }

    if (state === "active") {
      const cycle = trail.slice(trail.findIndex((step) => step.identity === identity)).map((step) => step.label);
      problems.push(`- cyclic dependency (${[...cycle, label].join(" → ")})`);
      return;
    }

    states.set(identity, "active");
    trail.push({ identity, label });

    for (const { name, identity: dependency } of overrides.has(identity)
      ? []
      : [...(edges.get(identity) ?? []), ...wrapperEdges(identity)]) {
      if (dependency !== undefined) {
        visit(dependency, name);
      }
    }

    trail.pop();
    states.set(identity, "done");
  }

  for (const identity of providers.keys()) {
    visit(identity, labelOf(identity));
  }

  // Every config a registered definition may resolve is read at startup, also one a definition resolved only on demand
  // or through a deferred reference reaches, so no resolution finds it unread. An overridden definition is a value that
  // resolves nothing, so a config only it requires is not read; each environment variable has one owning config.
  const reached = new Set<object>();
  const pending = [...providers.keys()].filter((identity) => !isConfig(identity));

  for (let identity = pending.pop(); identity !== undefined; identity = pending.pop()) {
    if (reached.has(identity)) {
      continue;
    }
    reached.add(identity);
    if (overrides.has(identity)) {
      continue;
    }
    for (const edge of [...(edges.get(identity) ?? []), ...wrapperEdges(identity), ...(deferred.get(identity) ?? [])]) {
      if (edge.identity !== undefined) {
        pending.push(edge.identity);
      }
    }
  }

  // The roots' configs include one an application lists without a definition requiring it.
  const configs = [...new Set([...paths.keys(), ...reached])].filter(
    (identity): identity is Config => isConfig(identity) && !overrides.has(identity),
  );

  const owners = new Map<string, Config>();

  for (const definition of configs) {
    for (const name of Object.keys(configVariables(definition))) {
      if (owners.has(name) && owners.get(name) !== definition) {
        problems.push(`- environment variable ${name} is declared by more than one config`);
      }
      owners.set(name, definition);
    }
  }

  return { paths, unbound, configs };
}
