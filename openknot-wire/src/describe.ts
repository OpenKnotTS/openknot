import type { DefinitionAdapterContext } from "./adapters.ts";
import { configVariables, isConfig } from "./config.ts";
import type { ApplicationDefinition, ValueOverride } from "./definition.ts";
import { isOptionalDependency } from "./dependencies.ts";
import type { Edge } from "./internal/composition.ts";
import { composeApplication, declaredRequirements, kindOf } from "./internal/composition.ts";
import type { Lifetime } from "./providers.ts";

/** How a described definition gets its value. */
export type DefinitionBinding = "implementation" | "unbound" | "override";
/** Why the application holds a definition beyond being available as a dependency. */
export type DefinitionRole = "root" | "intake" | "resource" | "scope-resource" | "startup-task" | "shutdown-task";

export interface DescribedDependency {
  readonly name: string;
  /** Absent when the dependency is unavailable, excluded, or an optional contract without an implementation. */
  readonly id?: number;
  readonly optional: boolean;
}

export interface DescribedDefinition {
  readonly id: number;
  readonly kind: string;
  readonly lifetime: Lifetime;
  readonly binding: DefinitionBinding;
  /** Requirement names under which other definitions declare this one. */
  readonly names: readonly string[];
  /** Dependencies resolved when the value is built, framework-internal ones included. */
  readonly dependencies: readonly DescribedDependency[];
  /** Deferred references, resolved only when an execution needs them. */
  readonly references: readonly number[];
  /** Decorations wrapping the value, innermost first. */
  readonly decorations: readonly { readonly dependencies: readonly DescribedDependency[] }[];
  readonly roles: readonly DefinitionRole[];
}

export interface ApplicationDescription {
  readonly definitions: readonly DescribedDefinition[];
  /** The environment variables the application reads through its reachable configs, sorted. */
  readonly environment: readonly string[];
  /** The startup validation problems runApplication() would reject with. */
  readonly problems: readonly string[];
}

/**
 * The composed dependency graph as plain data, without starting the application: no resource is acquired,
 * no intake opened and no task run.
 */
export async function describeApplication(
  definition: ApplicationDefinition,
  options: { readonly overrides?: readonly ValueOverride[] } = {},
): Promise<ApplicationDescription> {
  const context: DefinitionAdapterContext = Object.freeze({
    status: "starting" as const,
    stopping: new AbortController().signal,
    intakeOpen: false,
    withScope(): Promise<never> {
      return Promise.reject(new Error("describeApplication() does not run the application."));
    },
  });

  const composed = await composeApplication(definition, options.overrides ?? [], context, undefined);

  const { keys, providers, overrides, edges, deferred, wrappers, declaringDefinition } = composed;

  const ids = new Map([...providers.keys()].map((identity, index) => [identity, index + 1]));

  const names = new Map<object, Set<string>>();

  for (const identity of providers.keys()) {
    for (const [name, requirement] of Object.entries(declaredRequirements(declaringDefinition(identity)))) {
      const dependency = keys.get(isOptionalDependency(requirement) ? requirement.reference : requirement);
      if (dependency !== undefined) {
        names.set(dependency, (names.get(dependency) ?? new Set()).add(name));
      }
    }
  }

  const roles = new Map<object, DefinitionRole[]>();

  const assign = (references: readonly object[], role: DefinitionRole) => {
    for (const reference of references) {
      const identity = keys.get(reference);
      if (identity !== undefined && !roles.get(identity)?.includes(role)) {
        roles.set(identity, [...(roles.get(identity) ?? []), role]);
      }
    }
  };

  assign(composed.listedRoots, "root");

  assign(
    [...composed.resources, ...composed.intake].map((step) => step.key),
    "resource",
  );

  assign(
    composed.intake.map((step) => step.key),
    "intake",
  );

  assign(
    composed.scopeResources.map((step) => step.key),
    "scope-resource",
  );

  assign(composed.startupTasks, "startup-task");

  assign(composed.shutdownTasks, "shutdown-task");

  const describe = (requirements: readonly Edge[]): readonly DescribedDependency[] =>
    Object.freeze(
      requirements.map(({ name, identity, optional }) =>
        Object.freeze({
          name,
          optional,
          ...(identity === undefined ? {} : { id: ids.get(identity) as number }),
        }),
      ),
    );

  return Object.freeze({
    definitions: Object.freeze(
      [...providers].map(([identity, provider]): DescribedDefinition => {
        const binding: DefinitionBinding = overrides.has(identity)
          ? "override"
          : provider.required
            ? "unbound"
            : "implementation";
        return Object.freeze({
          id: ids.get(identity) as number,
          kind: isConfig(identity) ? "config" : kindOf(identity),
          lifetime: provider.lifetime,
          binding,
          names: Object.freeze([...(names.get(identity) ?? [])]),
          dependencies: describe(edges.get(identity) ?? []),
          // The same deferred edges validation follows.
          references: Object.freeze(
            (deferred.get(identity) ?? []).flatMap(({ identity: reference }) => {
              const id = reference === undefined ? undefined : ids.get(reference);
              return id === undefined ? [] : [id];
            }),
          ),
          decorations: Object.freeze(
            (wrappers.get(identity) ?? []).map((wrapper) => Object.freeze({ dependencies: describe(wrapper.edges) })),
          ),
          roles: Object.freeze(roles.get(identity) ?? []),
        });
      }),
    ),
    environment: Object.freeze(
      [...new Set(composed.configs.flatMap((definition) => Object.keys(configVariables(definition))))].sort(),
    ),
    problems: Object.freeze([...composed.problems]),
  });
}
