import type { EntriesGraph, GivesOfGraph, Graph, GraphNeeds, MissingImplementations, RootsOfGraph } from "./graph.ts";
import { GroupMarker, hasMarker, InputMarker } from "./internal/marker.ts";
import type { Activation, ModuleInput } from "./modules.ts";
import { isModuleInput, listedModule, requiredBy } from "./modules.ts";
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

/** An input port, such as an exposure, a listener or a topic; layers mark their own. */
export interface ApplicationInput {
  readonly [InputMarker]: true;
}

/** A named group of input ports, such as an exposure composition. */
export interface ApplicationInputGroup {
  readonly [GroupMarker]: true;
  readonly members: Readonly<Record<string, ApplicationInput>>;
}

/** A module, or a definition listed directly: a plug, resource, unit, decoration or composition. */
export type ApplicationEntry = ModuleInput | object;

export interface ApplicationOptions {
  /**
   * The application's input ports, such as exposures, listeners and their compositions. They are its roots: what
   * they need is followed through requirements, and the modules supply the implementations.
   */
  readonly inputs?: readonly (ApplicationInput | ApplicationInputGroup)[];
  /** Selected implementations: modules, or definitions listed directly. Their order is the module order. */
  readonly modules?: Activation | readonly ApplicationEntry[];
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
  readonly options: Required<Omit<ApplicationOptions, "modules" | "inputs">> & { readonly modules: Activation };
}

type Items<L> = L extends readonly (infer I)[] ? I : never;

/** A module's graph, or the graph of a definition listed directly, with its composition members. */
type EntryGraph<I> = I extends Graph ? I : EntriesGraph<I>;

type ModulesRoots<M> = M extends readonly (infer I)[]
  ? RootsOfGraph<EntryGraph<I>>
  : M extends Graph
    ? RootsOfGraph<M>
    : never;
type ModulesGives<M> = M extends readonly (infer I)[]
  ? GivesOfGraph<EntryGraph<I>>
  : M extends Graph
    ? GivesOfGraph<M>
    : never;

/** Definitions whose needs count: root modules' roots and lifecycle providers. */
export type ApplicationRoots<O extends ApplicationOptions> =
  | ModulesRoots<O["inputs"]>
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

/** Only input ports, or groups of them, are an application's inputs: handlers, guards and plugs join through requirements and modules. */
function checkedInputs(inputs: readonly object[]): readonly object[] {
  for (const entry of inputs) {
    const members = hasMarker(entry, GroupMarker)
      ? Object.values((entry as { readonly members: Readonly<Record<string, unknown>> }).members)
      : [entry];

    for (const member of members) {
      if (!hasMarker(member, InputMarker)) {
        const kind: unknown = typeof member === "object" && member !== null ? Reflect.get(member, "kind") : undefined;
        throw new TypeError(
          `defineApplication({ inputs }) accepts input ports, such as exposures and listeners${typeof kind === "string" ? `, not a ${kind}` : ""}.`,
        );
      }
    }
  }

  return inputs;
}

/** Modules as they are, and each run of definitions listed between them as one module, keeping the module order. */
function asModules(entries: readonly ApplicationEntry[]): ModuleInput[] {
  const modules: ModuleInput[] = [];
  let run: object[] = [];

  for (const entry of entries) {
    if (isModuleInput(entry)) {
      if (run.length > 0) {
        modules.push(listedModule(run, "defineApplication({ modules })"));
        run = [];
      }
      modules.push(entry);
    } else {
      run.push(entry);
    }
  }

  if (run.length > 0) {
    modules.push(listedModule(run, "defineApplication({ modules })"));
  }

  return modules;
}

/** Option names defineApplication() does not know, such as a misspelt one, fail to compile. */
type KnownOptions<O> = { readonly [K in Exclude<keyof O, keyof ApplicationOptions>]: never };

export function defineApplication<const O extends ApplicationOptions>(
  options: O & KnownOptions<O>,
): ApplicationDefinition<ApplicationRoots<O>, ApplicationGives<O>> {
  // The graph lives in the result's type; the value only needs the known options.
  const input: ApplicationOptions = options;
  const listed = input.modules ?? [];
  const requested = "rootSelections" in listed ? listed : requiredBy(...asModules(listed));
  const inputs =
    input.inputs === undefined ? [] : [listedModule(checkedInputs(input.inputs), "defineApplication({ inputs })")];

  const modules = Object.freeze({
    selections: Object.freeze([...inputs, ...requested.selections]),
    rootSelections: Object.freeze([...inputs, ...requested.rootSelections]),
  }) as Activation;

  const { inputs: _inputs, ...rest } = input;

  return Object.freeze({
    options: Object.freeze({
      ...rest,
      modules,
      resourceOrder: Object.freeze([...(input.resourceOrder ?? [])]),
      startupTasks: Object.freeze([...(input.startupTasks ?? [])]),
      shutdownTasks: Object.freeze([...(input.shutdownTasks ?? [])]),
    }),
  }) as ApplicationDefinition<ApplicationRoots<O>, ApplicationGives<O>>;
}
