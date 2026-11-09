import type { GivesOfGraph, Graph, GraphNeeds, MissingImplementations, RootsOfGraph } from "./graph.ts";
import type { Activation, ModuleInput } from "./modules.ts";
import { requiredBy } from "./modules.ts";
import type { ApplicationHook, Definition, Provider, Resolved } from "./providers.ts";
import { unit } from "./providers.ts";

export type ApplicationStatus = "starting" | "ready" | "stopping" | "stopped";

/**
 * Reads the current lifecycle status of the application that resolves it. Every runApplication() supplies
 * its own, so listing it in requirements is enough; the result is always the live value, not a snapshot.
 */
export const applicationStatus = unit({
  factory: (): (() => ApplicationStatus) => {
    throw new Error("applicationStatus is supplied by runApplication().");
  },
});

export interface ValueOverride<T extends Definition = Definition> {
  readonly target: T;
  readonly value: unknown;
}

export function override<P extends Definition>(target: P, value: NoInfer<Resolved<P>>): ValueOverride<P> {
  return Object.freeze({ target, value });
}

export interface ApplicationOptions {
  readonly modules: Activation | readonly ModuleInput[];
  /**
   * Resources opened first in their phase, one by one in this order, each after what it depends on; the rest follow.
   * Ordinary resources always open before what brings work in, and everything closes in reverse.
   */
  readonly resourceOrder?: readonly Definition[];
  readonly startupTasks?: readonly Provider<ApplicationHook, never, "hook">[];
  readonly shutdownTasks?: readonly Provider<ApplicationHook, never, "hook">[];
}

/** An application's graph. */
export interface ApplicationDefinition<R = any, G = any> extends Graph<R, G> {
  readonly options: Required<Omit<ApplicationOptions, "modules">> & { readonly modules: Activation };
}

type Items<L> = L extends readonly (infer I)[] ? I : never;

type ModulesRoots<M> = M extends readonly (infer I)[] ? RootsOfGraph<I> : M extends Graph ? RootsOfGraph<M> : never;
type ModulesGives<M> = M extends readonly (infer I)[] ? GivesOfGraph<I> : M extends Graph ? GivesOfGraph<M> : never;

/** Definitions whose needs count: root modules' roots and lifecycle providers. */
export type ApplicationRoots<O extends ApplicationOptions> =
  | ModulesRoots<O["modules"]>
  | Items<O["resourceOrder"]>
  | Items<O["startupTasks"]>
  | Items<O["shutdownTasks"]>;

/** Contracts implemented by every selected module. */
export type ApplicationGives<O extends ApplicationOptions> = ModulesGives<O["modules"]>;
export type OverrideTargets<O> = O extends readonly (infer V)[]
  ? V extends ValueOverride<infer T>
    ? T
    : never
  : never;

/**
 * Requires `missingImplementations` naming every unbound contract, so the call itself reports them. The needs
 * are those of the final graph: the overridden targets `Targets` contribute none of their own, while every other
 * definition keeps what it reaches, also through a dependency it shares with them.
 */
export type ApplicationCheck<D, Targets> =
  D extends ApplicationDefinition<infer R, infer G>
    ? [MissingImplementations<GraphNeeds<R, Targets>, G | Targets>] extends [never]
      ? unknown
      : { readonly missingImplementations: MissingImplementations<GraphNeeds<R, Targets>, G | Targets> }
    : unknown;

/** Option names defineApplication() does not know, such as a misspelt one, fail to compile. */
type KnownOptions<O> = { readonly [K in Exclude<keyof O, keyof ApplicationOptions>]: never };

export function defineApplication<const O extends ApplicationOptions>(
  options: O & KnownOptions<O>,
): ApplicationDefinition<ApplicationRoots<O>, ApplicationGives<O>> {
  // The graph lives in the result's type; the value only needs the known options.
  const input: ApplicationOptions = options;
  const requested = "rootSelections" in input.modules ? input.modules : requiredBy(...input.modules);

  const modules = Object.freeze({
    selections: Object.freeze([...requested.selections]),
    rootSelections: Object.freeze([...requested.rootSelections]),
  }) as Activation;

  return Object.freeze({
    options: Object.freeze({
      ...input,
      modules,
      resourceOrder: Object.freeze([...(input.resourceOrder ?? [])]),
      startupTasks: Object.freeze([...(input.startupTasks ?? [])]),
      shutdownTasks: Object.freeze([...(input.shutdownTasks ?? [])]),
    }),
  }) as ApplicationDefinition<ApplicationRoots<O>, ApplicationGives<O>>;
}
