import type { Lifetime } from "../providers.ts";

/** Builds one definition's value, resolving its dependencies through the given function. */
export interface Registration {
  readonly lifetime: Lifetime;
  /** A scoped value that serves the whole application: built once, resolved only from scopes. */
  readonly shared?: true;
  build(resolve: (identity: object) => unknown): unknown;
}

export interface ResolutionScope {
  resolve(identity: object): unknown;
  /** Supplies a value owned by this scope, such as an initialized resource. */
  provide(identity: object, value: unknown): void;
  release(): void;
}

export interface RootScope extends ResolutionScope {
  createScope(): ResolutionScope;
}

function outsideScope(): Error {
  return new Error("Resolve scoped providers through withScope().");
}

/**
 * Lifetime caches over a graph validated at startup. Singletons are cached in the root and always
 * resolve their dependencies there; scoped values are cached by the scope that first resolves them, except shared
 * ones, which the first scope builds for all of them; transient values are rebuilt on every resolution.
 */
export function createRootScope(registrations: ReadonlyMap<object, Registration>, unavailable: () => Error): RootScope {
  const singletons = new Map<object, unknown>();
  const shared = new Map<object, unknown>();

  function open(values: Map<object, unknown>): ResolutionScope {
    function resolve(identity: object): unknown {
      if (values.has(identity)) {
        return values.get(identity);
      }

      const registration = registrations.get(identity);

      if (registration === undefined) {
        throw unavailable();
      }

      if (registration.lifetime === "transient") {
        return registration.build(resolve);
      }

      if (registration.lifetime === "singleton" && values !== singletons) {
        return root.resolve(identity);
      }

      // Only a scope owns scoped values; the root would keep one for the whole application.
      if (registration.lifetime === "scoped" && values === singletons) {
        throw outsideScope();
      }

      const cache = registration.shared === true ? shared : values;

      if (cache.has(identity)) {
        return cache.get(identity);
      }

      const value = registration.build(resolve);
      cache.set(identity, value);

      return value;
    }

    return Object.freeze({
      resolve,
      provide(identity: object, value: unknown): void {
        values.set(identity, value);
      },
      release(): void {
        values.clear();
      },
    });
  }

  const root = open(singletons);

  return Object.freeze({ ...root, createScope: () => open(new Map()) });
}
