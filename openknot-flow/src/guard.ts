import type { Requirements, ResolvedRequirements } from "./definitions.ts";
import { snapshotRequirements } from "./definitions.ts";
import type { FlowExecutionError } from "./errors.ts";
import type { ExecutionActor, ExecutionOptions } from "./execution.ts";
import { integration } from "./internal/integration.ts";
import { ownField } from "./internal/request.ts";
import type { ErrorOf, Outcome } from "@openknot-ts/behavior";
import { declarable } from "@openknot-ts/behavior/internal/declarable";
import { executable } from "@openknot-ts/behavior/internal/executable";
import { hasMarker } from "@openknot-ts/wire/internal/marker";
import type { NoRequirements, RequirementsOptions } from "@openknot-ts/wire/internal/requirements";

export const GuardMarker = Symbol.for("@openknot-ts/flow/guard");
/** Internal execution hook; the wire supplies the guard's resolved dependencies. */
export const GuardRun = Symbol.for("@openknot-ts/flow/guard-run");

export type GuardResult = Outcome<void, Error> | PromiseLike<Outcome<void, Error>>;

export type GuardContext<R extends Requirements> = ResolvedRequirements<R> & {
  readonly signal: AbortSignal;
  readonly actor: ExecutionActor | undefined;
};

export interface GuardDefinition {
  readonly [GuardMarker]: true;
  readonly kind: "guard";
  readonly requirements: Requirements;
  readonly [GuardRun]: (input: never, ctx: never) => GuardResult;
}

export interface Guard<I, R extends Requirements, O extends GuardResult> extends GuardDefinition {
  readonly requirements: R;
  readonly [GuardRun]: (input: I, ctx: GuardContext<R>) => O;
}

export type Guards = Readonly<Record<string, GuardDefinition>>;
export type NoGuards = Readonly<Record<never, never>>;

/** Shared reference graph for guarded ports, without capturing resolved values. */
export function guardedReferences(port: {
  readonly requirements: Requirements;
  readonly guards: Guards;
}): readonly object[] {
  return Object.freeze([...Object.values(port.requirements), ...Object.values(port.guards)]);
}

/** Shared declaration and invocation shapes for ports with optional guards. */
export interface GuardOptions<G extends Guards | undefined = Guards> {
  readonly guards?: (G & GuardNames<NoInfer<Extract<G, Guards>>>) | Extract<G, undefined>;
}

export type GuardInput<G> = G extends Guard<infer I, infer _R, infer _O> ? I : never;
export type GuardError<G> = G extends Guard<infer _I, infer _R, infer O> ? ErrorOf<Awaited<O>> : never;

/**
 * One rule for every request field an input fills: a field whose input type is void carries no data, so a caller
 * may leave it out; any other is required. An absent field reads as undefined.
 */
type DataFields<G extends Guards> = { [K in keyof G]: [GuardInput<G[K]>] extends [void] ? never : K }[keyof G];
export type GuardInputs<G extends Guards> = { readonly [K in DataFields<G>]: GuardInput<G[K]> } & {
  readonly [K in Exclude<keyof G, DataFields<G>>]?: GuardInput<G[K]>;
};

/** The `input` field under the same rule: an input of type void may be left out. */
export type InputField<I> = [I] extends [void] ? { readonly input?: I } : { readonly input: I };

export type GuardErrors<G extends Guards> = GuardError<G[keyof G]>;
export type GuardRequest<I, G extends Guards = NoGuards> = GuardInputs<G> & InputField<I> & ExecutionOptions;

export interface GuardExecutionOptions {
  readonly signal?: AbortSignal;
}

export type ExecutableGuard<I, E extends Error> = (
  input: I,
  options?: GuardExecutionOptions,
) => Promise<Outcome<void, E | FlowExecutionError>>;

export interface GuardFactory<I> {
  <const R extends Requirements = NoRequirements, O extends GuardResult = GuardResult>(
    options: RequirementsOptions<R> & {
      readonly run: (input: I, ctx: GuardContext<R>) => O;
    },
  ): Guard<I, R, O>;
}

/** The input goes on the head, `guard<Input>()({ ... })`; `guard({ ... })` takes none. */
export interface GuardConstructor extends GuardFactory<void> {
  <I = void>(): GuardFactory<I>;
}

function createGuard<I, const R extends Requirements, O extends GuardResult>(
  options: RequirementsOptions<R> & {
    readonly run: (input: I, ctx: GuardContext<R>) => O;
  },
): Guard<I, R, O> {
  const definition = executable({
    marker: GuardMarker,
    kind: "guard",
    hook: GuardRun,
    run: options.run,
    invalidRunMessage: "guard() requires run().",
    integration,
    define: () => ({ requirements: snapshotRequirements(options.requirements, ["actor", "__environment"]) }),
  });
  return definition;
}

export const guard = declarable<GuardConstructor>(createGuard);

export function isGuard(value: unknown): value is GuardDefinition {
  return hasMarker(value, GuardMarker);
}

/** Shared request fields; named guard inputs cannot shadow them. */
type ReservedGuardName = "input" | keyof ExecutionOptions;

const requestFields: ReadonlySet<string> = new Set<ReservedGuardName>([
  "input",
  "signal",
  "actor",
  "propagation",
  "traceAttributes",
]);

export type GuardNames<G extends Guards> = { readonly [K in Extract<keyof G, ReservedGuardName>]: never };

/** One declaration contract for all guardable mechanisms. */
export function snapshotGuardOptions(options: GuardOptions<Guards | undefined>): { readonly guards: Guards } {
  return { guards: snapshotGuards(options.guards) };
}

/** Normalize optional guards once; definitions retain their original DI identities. */
function snapshotGuards(guards: Guards | undefined): Guards {
  if (guards === undefined) {
    return Object.freeze({});
  }

  if (typeof guards !== "object" || guards === null || Array.isArray(guards)) {
    throw new TypeError("Guards must be a named object of guard() definitions.");
  }

  const snapshot = Object.freeze({ ...guards });

  for (const [name, definition] of Object.entries(snapshot)) {
    if (requestFields.has(name)) {
      throw new TypeError(`Guard name '${name}' is reserved`);
    }
    if (!isGuard(definition)) {
      throw new TypeError(`Invalid guard '${name}': use guard().`);
    }
  }

  return snapshot;
}

/**
 * All guardables read independent named inputs from the same request shape, validated by their callers; a port
 * reads its names once. The runtime does not know which inputs are void, so an absent field reads as undefined
 * for every name, while the types still require each field that carries data. A field nothing reads is rejected.
 */
export function guardInputReader(guards: Guards): (request: object) => Readonly<Record<string, unknown>> {
  const names = Object.keys(guards);

  return (request) => {
    for (const name of Object.keys(request)) {
      if (!requestFields.has(name) && !Object.hasOwn(guards, name)) {
        throw new TypeError(`Unexpected guardable request field '${name}'`);
      }
    }
    return Object.freeze(Object.fromEntries(names.map((name) => [name, ownField(request, name)])));
  };
}
