import type { AnyProvider } from "../providers.ts";
import type { Edge, ResolvedGraph, Wrapper } from "./composition.ts";
import { kindOf, unavailable } from "./composition.ts";
import type { Registration } from "./container.ts";
import { discardedThenable } from "./synchronous.ts";

function synchronousResult(value: unknown, identity: object): unknown {
  if (discardedThenable(value)) {
    throw new TypeError(
      `The ${kindOf(identity)} factory returned a Promise. Factories must be synchronous; use resource().initialize() for async work.`,
    );
  }
  return value;
}

/** How each definition's value is built, from what composition resolved once. */
export function createRegistrations(
  graph: Pick<ResolvedGraph, "providers" | "overrides" | "edges" | "definitions"> & {
    readonly wrappers: ReadonlyMap<object, readonly Wrapper[]>;
  },
  supplied: (identity: object) => (() => unknown) | undefined,
) {
  const { providers, overrides, edges, wrappers, definitions } = graph;
  const applicationWide = new Map<object, boolean>();

  /** Whether one value serves the whole application: a singleton, or a pure definition over such values only. */
  function isApplicationWide(identity: object): boolean {
    const known = applicationWide.get(identity);

    if (known !== undefined) {
      return known;
    }

    const provider = providers.get(identity);
    const answer =
      overrides.has(identity) ||
      supplied(identity) !== undefined ||
      (provider !== undefined &&
        !provider.required &&
        (provider.lifetime === "singleton" ||
          (provider.lifetime === "scoped" &&
            provider.kind === "unit" &&
            definitions.get(identity)?.pure === true &&
            [
              ...(edges.get(identity) ?? []),
              ...(wrappers.get(identity) ?? []).flatMap((wrapper) => wrapper.edges),
            ].every(({ identity: dependency }) => dependency === undefined || isApplicationWide(dependency)))));
    applicationWide.set(identity, answer);
    return answer;
  }

  function registrationOf(identity: object, provider: AnyProvider): Registration {
    const lifetime = provider.lifetime;
    const shared = lifetime === "scoped" && isApplicationWide(identity) ? ({ shared: true } as const) : {};
    if (overrides.has(identity)) {
      const value = overrides.get(identity);
      return { lifetime, ...shared, build: () => value };
    }

    if (provider.required) {
      // A contract resolved on demand while unbound; validation already reports the ones startup reaches.
      return {
        lifetime,
        build(): never {
          throw new Error(
            `The ${kindOf(identity)} has no implementation. Bind it with a plug or provides, or supply it through override().`,
          );
        },
      };
    }

    if (provider.kind === "resource") {
      return {
        lifetime,
        build(): never {
          throw new Error(
            `The ${kindOf(identity)} is not acquired here: nothing the application starts reaches it, or this scope's own resources leave it out.`,
          );
        },
      };
    }

    const supply = supplied(identity);

    if (supply !== undefined) {
      return decorated(identity, { lifetime: "singleton", build: supply });
    }

    return decorated(identity, { ...registrationFor(identity, provider), ...shared });
  }

  // Requirement names exclude __proto__ at declaration, so a plain object stays in V8's fast mode.
  function resolveEdges(requirements: readonly Edge[], resolve: (identity: object) => unknown): unknown {
    const dependencies: Record<string, unknown> = {};
    for (const { name, identity: dependency, optional } of requirements) {
      if (dependency === undefined && !optional) {
        throw unavailable();
      }
      dependencies[name] = dependency === undefined ? undefined : resolve(dependency);
    }
    return Object.freeze(dependencies);
  }

  function decorated(identity: object, base: Registration): Registration {
    const chain = wrappers.get(identity);

    if (chain === undefined) {
      return base;
    }

    return {
      lifetime: base.lifetime,
      ...(base.shared === true ? { shared: true } : {}),
      build(resolve): unknown {
        let value = base.build(resolve);
        for (const { decoration, edges: requirements } of chain) {
          value = synchronousResult(
            decoration.wrap(value as never, resolveEdges(requirements, resolve) as never),
            identity,
          );
        }
        return value;
      },
    };
  }

  function registrationFor(identity: object, provider: AnyProvider): Registration {
    const requirements = edges.get(identity) ?? [];

    if (provider.kind === "collection") {
      return {
        lifetime: provider.lifetime,
        build: (resolve) =>
          Object.freeze(
            requirements.map((member) => {
              if (member.identity === undefined) {
                throw unavailable();
              }
              return resolve(member.identity);
            }),
          ),
      };
    }

    return {
      lifetime: provider.lifetime,
      build: (resolve) => synchronousResult(provider.factory(resolveEdges(requirements, resolve) as never), identity),
    };
  }

  const registrations = new Map<object, Registration>();

  for (const [identity, provider] of providers) {
    registrations.set(identity, registrationOf(identity, provider));
  }

  return { registrations, registrationFor };
}
