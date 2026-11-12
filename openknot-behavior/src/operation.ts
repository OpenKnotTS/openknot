import type { Event } from "./event.ts";
import type { Composition } from "./internal/composable.ts";
import { composable } from "./internal/composable.ts";
import { declarable } from "./internal/declarable.ts";
import { executable } from "./internal/executable.ts";
import { integration } from "./internal/integration.ts";
import type { BehaviorResolved } from "./internal/resolved.ts";
import type { ErrorOf, Outcome, SuccessOf } from "./outcome.ts";
import type { ReaderDefinition } from "./reader.ts";
import { isReader } from "./reader.ts";
import type { Logger } from "@openknot-ts/logging";
import { isLoggerReference } from "@openknot-ts/logging";
import type { LoggerReference } from "@openknot-ts/logging/wire";
import { DefinitionIntegrationMarker, hasMarker } from "@openknot-ts/wire/internal/marker";
import type { NoRequirements, RequirementsOptions } from "@openknot-ts/wire/internal/requirements";
import { snapshotRequirements } from "@openknot-ts/wire/internal/requirements";

export const OperationMarker = Symbol.for("@openknot-ts/behavior/operation");

/** Internal invocation hook. Deliberately not exported from the package entry. */
export const OperationRun = Symbol.for("@openknot-ts/behavior/operation-run");

/** Type-only event contract; no runtime registration or event catalogue. */
declare const OperationEventType: unique symbol;

export type OperationOutput<State> =
  | {
      readonly changeType: "created" | "updated";
      readonly next: State;
      readonly previous?: never;
      readonly current?: never;
    }
  | { readonly changeType: "deleted"; readonly previous: State; readonly next?: never; readonly current?: never }
  | { readonly changeType: "unchanged"; readonly current: State; readonly next?: never; readonly previous?: never };

/** One change, or the changes of several states of the same model. */
type OperationChanges<State> = OperationOutput<State> | readonly OperationOutput<State>[];

/** True when nothing changed: an unchanged output, or a list of only unchanged outputs (empty included). */
type Unchanged<Output> = [Output] extends [readonly (infer Change)[]]
  ? [Change] extends [{ readonly changeType: "unchanged" }]
    ? true
    : false
  : [Output] extends [{ readonly changeType: "unchanged" }]
    ? true
    : false;

type EmittedEvents<Output, E extends Event> = Output extends unknown
  ? Unchanged<Output> extends true
    ? never
    : E
  : never;
type ChangedDraft<Output, E extends Event> = Output extends unknown
  ? Unchanged<Output> extends true
    ? never
    : { readonly output: Output; readonly events: readonly E[] }
  : never;

export type OperationDraft<
  Output extends OperationChanges<unknown> = OperationChanges<unknown>,
  E extends Event = never,
> = [E] extends [never]
  ? { readonly output: Output; readonly events?: never }
  : { readonly output: Output; readonly events: readonly never[] } | ChangedDraft<Output, E>;

export type OperationSuccess<Output extends OperationChanges<unknown>, E extends Event = never> = [E] extends [never]
  ? { readonly output: Output }
  : Output extends unknown
    ? { readonly output: Output; readonly events: readonly EmittedEvents<Output, E>[] }
    : never;

type ExecutionResult<Draft> = Outcome<Draft, Error> | PromiseLike<Outcome<Draft, Error>>;

/** Heterogeneous execution boundary; authoring uses the declared event contract. */
export type OperationExecutionResult = ExecutionResult<{
  readonly output: OperationChanges<unknown>;
  readonly events?: readonly Event[];
}>;

export interface OperationDefinition {
  readonly [OperationMarker]: true;
  readonly kind: "operation";
  readonly requirements: Requirements;
  readonly tag?: string;
  readonly [OperationRun]: (input: never, ctx: never) => OperationExecutionResult;
}

/** Readers and operations, plus the logger: the only effect an operation performs, since it never changes the outcome. */
export type Requirement = ReaderDefinition | OperationDefinition | LoggerReference;
export type Requirements = Readonly<Record<string, Requirement>>;

export type ResolvedRequirement<D> = D extends LoggerReference
  ? Logger
  : D extends Requirement
    ? BehaviorResolved<D>
    : never;

export type ResolvedRequirements<R extends Requirements> = {
  readonly [K in keyof R]: ResolvedRequirement<R[K]>;
};

type ChangeValue<Output> = Output extends readonly (infer Change)[]
  ? readonly ChangeValue<Change>[]
  : Output extends {
        readonly changeType: infer Kind extends "created" | "updated";
        readonly next: infer State;
      }
    ? { readonly changeType: Kind; readonly next: State }
    : Output extends { readonly changeType: "deleted"; readonly previous: infer State }
      ? { readonly changeType: "deleted"; readonly previous: State }
      : Output extends { readonly changeType: "unchanged"; readonly current: infer State }
        ? { readonly changeType: "unchanged"; readonly current: State }
        : never;

type OutputOf<Draft> = Draft extends { readonly output: infer Output } ? ChangeValue<Output> : never;

export type OperationValue<Result, E extends Event = never> = [SuccessOf<Awaited<Result>>] extends [never]
  ? never
  : OperationSuccess<OutputOf<SuccessOf<Awaited<Result>>>, E>;

export type ExecutableOperation<Input, Result extends OperationExecutionResult, E extends Event = never> = (
  input: Input,
) => Promise<Outcome<OperationValue<Result, E>, ErrorOf<Awaited<Result>>>>;

export interface Operation<
  Input,
  R extends Requirements,
  Result extends OperationExecutionResult,
  E extends Event = never,
> extends OperationDefinition {
  readonly [OperationEventType]?: E;
  readonly requirements: R;
  readonly [OperationRun]: (input: Input, ctx: ResolvedRequirements<R>) => Result;
}

/** The authored input contract, independent of standalone or wire resolution. */
export type OperationInput<D extends OperationDefinition> = Parameters<D[typeof OperationRun]>[0];
/** The authored errors, as `HandlerErrors` names a handler's. */
export type OperationErrors<D extends OperationDefinition> = ErrorOf<Awaited<ReturnType<D[typeof OperationRun]>>>;

/** Declared event elements, including contracts on operations that emit no events. */
export type OperationEvents<D extends OperationDefinition> =
  D extends Operation<infer _Input, infer _R, infer _Result extends OperationExecutionResult, infer E extends Event>
    ? E
    : never;

export interface OperationFactory<Input, State = unknown, E extends Event = never> {
  <
    const R extends Requirements = NoRequirements,
    Result extends ExecutionResult<OperationDraft<OperationChanges<State>, E>> = ExecutionResult<
      OperationDraft<OperationChanges<State>, E>
    >,
  >(
    options: RequirementsOptions<R> & {
      readonly tag?: string;
      readonly run: (input: Input, ctx: ResolvedRequirements<R>) => Result;
    },
  ): Operation<Input, R, Result, E>;
}

/**
 * A declared contract goes on the head, `operation<Input, State, Event>()({ ... })`, and the second call infers the
 * requirements and errors. With nothing to declare, `operation({ ... })` takes no input and infers its state.
 */
export interface OperationConstructor extends OperationFactory<void> {
  <Input = void, State = unknown, E extends Event = never>(): OperationFactory<Input, State, E>;
}

function createOperation<Input, const R extends Requirements, Result extends OperationExecutionResult>(
  options: RequirementsOptions<R> & {
    readonly tag?: string;
    readonly run: (input: Input, ctx: ResolvedRequirements<R>) => Result;
  },
): Operation<Input, R, Result> {
  const definition = executable({
    marker: OperationMarker,
    kind: "operation",
    hook: OperationRun,
    run: options.run,
    invalidRunMessage: "operation() requires a run function.",
    integration,
    define: () => ({
      requirements: snapshotRequirements(options.requirements, {
        accepts: (dependency) => isReader(dependency) || isOperation(dependency) || isLoggerReference(dependency),
        invalidMessage: (name) => `Invalid operation requirement: ${name}`,
      }),
      ...(options.tag === undefined ? {} : { tag: options.tag }),
    }),
  });
  return definition;
}

export function isOperation(value: unknown): value is OperationDefinition {
  return hasMarker(value, OperationMarker);
}

export const OperationCompositionMarker = Symbol.for("@openknot-ts/behavior/operation-composition");

export interface OperationComposition<
  P extends Readonly<Record<string, OperationDefinition>> = Readonly<Record<string, OperationDefinition>>,
> extends Composition<typeof OperationCompositionMarker, "operation-composition", P> {}

/** Group independent operations without introducing an executable or DI identity. */
export const operation: OperationConstructor & {
  readonly compose: <const P extends Readonly<Record<string, OperationDefinition>>>(
    members: P,
  ) => OperationComposition<P>;
} = composable(declarable<OperationConstructor>(createOperation), {
  name: "operation",
  memberName: "operation",
  marker: OperationCompositionMarker,
  kind: "operation-composition",
  isMember: isOperation,
  metadata: (members) => ({ [DefinitionIntegrationMarker]: integration(members) }),
});

export function isOperationComposition(value: unknown): value is OperationComposition {
  return hasMarker(value, OperationCompositionMarker);
}
