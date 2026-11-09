import { integration } from "./internal/integration.ts";
import type { Deleted, OperationOutput } from "@openknot-ts/behavior";
import type { Bindable, BindingFunction, ImplementationBinding } from "@openknot-ts/behavior/internal/bindable";
import { bindable, ImplementationBindingMarker, isBindableBinding } from "@openknot-ts/behavior/internal/bindable";
import type { Composition } from "@openknot-ts/behavior/internal/composable";
import { composable } from "@openknot-ts/behavior/internal/composable";
import { BindPort, DefinitionIntegrationMarker, hasMarker } from "@openknot-ts/wire/internal/marker";

/** The implementation's reported persistence state, without distinguishing insert from update. */
export interface Upserted<State> {
  readonly changeType: "upserted";
  readonly next: State;
}

/** Retains the supplied state; write verification belongs to the implementation and commit to the UoW. */
export function upserted<State>(next: State): Upserted<State> {
  return Object.freeze({ changeType: "upserted", next });
}

type ChangeOf<O, Kind> = Extract<O, { readonly changeType: Kind }>;
type ChangedState<O> = O extends { readonly changeType: "created" | "updated"; readonly next: infer State }
  ? State
  : O extends { readonly changeType: "deleted"; readonly previous: infer State }
    ? State
    : O extends { readonly changeType: "unchanged"; readonly current: infer State }
      ? State
      : never;

type Changes = OperationOutput<unknown> | readonly OperationOutput<unknown>[];
type ChangeItem<O> = [O] extends [readonly (infer Change)[]] ? Change : O;

/** A single output writes one state; a list writes its states in one call. A mix of both has no writer. */
type Write<O, State, Receipt> = [O] extends [readonly unknown[]]
  ? (states: readonly State[]) => PromiseLike<readonly Receipt[]>
  : [O] extends [OperationOutput<unknown>]
    ? (state: State) => PromiseLike<Receipt>
    : never;

/** The writers persist() needs: an upsert when the output can create or update, a delete when it can delete. */
export type PersistWriters<O extends Changes, State = ChangedState<ChangeItem<O>>> = ([
  ChangeOf<ChangeItem<O>, "created" | "updated">,
] extends [never]
  ? { readonly upsert?: Write<O, State, Upserted<State>> }
  : { readonly upsert: Write<O, State, Upserted<State>> }) &
  ([ChangeOf<ChangeItem<O>, "deleted">] extends [never]
    ? { readonly delete?: Write<O, State, Deleted<State>> }
    : { readonly delete: Write<O, State, Deleted<State>> });

/** The persisted state: the upserted or unchanged state, or undefined once deleted; a list keeps its order and drops deletions. */
export type Persisted<O extends Changes> = [O] extends [readonly (infer Change)[]]
  ? readonly ChangedState<Exclude<Change, ChangeOf<Change, "deleted">>>[]
  : ChangedState<Exclude<O, ChangeOf<O, "deleted">>> | ([ChangeOf<O, "deleted">] extends [never] ? never : undefined);

type Writers<Upsert, Delete> = { readonly upsert?: Upsert; readonly delete?: Delete };
type SingleWriters = Writers<
  (state: unknown) => PromiseLike<Upserted<unknown>>,
  (state: unknown) => PromiseLike<unknown>
>;
type ListWriters = Writers<
  (states: readonly unknown[]) => PromiseLike<readonly Upserted<unknown>[]>,
  (states: readonly unknown[]) => PromiseLike<unknown>
>;

/**
 * Applies an operation's output: created/updated upsert their next state, deleted deletes its previous state, unchanged
 * writes nothing. A list upserts all its next states in one call, then deletes all its previous states in one call.
 */
export function persist<const O extends Changes>(output: O, writers: PersistWriters<O>): Promise<Persisted<O>>;
export async function persist(output: Changes, writers: Writers<unknown, unknown>): Promise<unknown> {
  return Array.isArray(output)
    ? persistList(output, writers as ListWriters)
    : persistOne(output as OperationOutput<unknown>, writers as SingleWriters);
}

async function persistList(outputs: readonly OperationOutput<unknown>[], writers: ListWriters): Promise<unknown[]> {
  const upserts = outputs.flatMap((output) =>
    output.changeType === "created" || output.changeType === "updated" ? [output.next] : [],
  );
  const deletions = outputs.flatMap((output) => (output.changeType === "deleted" ? [output.previous] : []));
  const receipts = upserts.length === 0 ? [] : await writers.upsert!(upserts);

  if (receipts.length !== upserts.length) {
    throw new TypeError(`An upsert writer returned ${receipts.length} receipts for ${upserts.length} states.`);
  }

  if (deletions.length !== 0) {
    await writers.delete!(deletions);
  }

  let written = 0;
  return outputs.flatMap((output) => {
    switch (output.changeType) {
      case "created":
      case "updated":
        return [receipts[written++]!.next];
      case "deleted":
        return [];
      case "unchanged":
        return [output.current];
    }
  });
}

async function persistOne(output: OperationOutput<unknown>, writers: SingleWriters): Promise<unknown> {
  switch (output.changeType) {
    case "created":
    case "updated":
      return (await writers.upsert!(output.next)).next;
    case "deleted":
      await writers.delete!(output.previous);
      return undefined;
    case "unchanged":
      return output.current;
  }
}

/** Erases heterogeneous function arguments without accepting unsafe any. */
export type WriterFunction = BindingFunction;
export const WriterMarker = Symbol.for("@openknot-ts/flow/writer");
export const WriterBindingMarker = Symbol.for("@openknot-ts/flow/writer-binding");
export const WriterCompositionMarker = Symbol.for("@openknot-ts/flow/writer-composition");

export interface WriterDefinition {
  readonly [WriterMarker]: true;
  readonly kind: "writer";
}

export interface Writer<F extends WriterFunction> extends WriterDefinition, Bindable<F, WriterBinding<F>> {}

export interface WriterBinding<F extends WriterFunction = WriterFunction> extends ImplementationBinding<F> {
  readonly [WriterBindingMarker]: true;
  readonly writer: Writer<F>;
}

export interface WriterComposition<
  P extends Readonly<Record<string, WriterDefinition>> = Readonly<Record<string, WriterDefinition>>,
> extends Composition<typeof WriterCompositionMarker, "writer-composition", P> {}

type Managed<T> = T extends { readonly entity: infer E extends string; readonly id: string | number | bigint }
  ? string extends E
    ? never
    : T
  : never;

type Element<T> = T extends readonly (infer Item)[] ? Item : T;

type UpsertedState<T> = T extends Upserted<infer State> ? State : never;

type DeletedPayload<T> = T extends { readonly changeType: "deleted"; readonly previous: infer Payload }
  ? Payload
  : never;

/** A writer of managed states deletes with the full state, which identifies the entity and carries its version. */
type ManagedDeletions<F> = F extends (...args: infer A) => infer R
  ? [Managed<Element<A[number]>> | Managed<UpsertedState<Element<Awaited<R>>>>] extends [never]
    ? []
    : [Exclude<DeletedPayload<Element<Awaited<R>>>, Managed<DeletedPayload<Element<Awaited<R>>>>>] extends [never]
      ? []
      : [managedWriterDeletionPayloadMustBeTheFullState: never]
  : [];

function createWriter<F extends WriterFunction>(..._check: ManagedDeletions<F>): Writer<F> {
  return bindable<F, Writer<F>, WriterBinding<F>>({
    name: "writer",
    define: (bindPort) => ({
      [WriterMarker]: true,
      [DefinitionIntegrationMarker]: integration(),
      kind: "writer",
      [BindPort]: bindPort,
    }),
    bind: (writer, implementation) => ({
      [ImplementationBindingMarker]: true,
      [WriterBindingMarker]: true,
      [DefinitionIntegrationMarker]: integration([writer]),
      writer,
      implementation,
    }),
  });
}

export const writer: typeof createWriter & {
  readonly compose: <const P extends Readonly<Record<string, WriterDefinition>>>(members: P) => WriterComposition<P>;
} = composable(createWriter, {
  name: "writer",
  memberName: "writer",
  marker: WriterCompositionMarker,
  kind: "writer-composition",
  isMember: isWriter,
  metadata: (members) => ({ [DefinitionIntegrationMarker]: integration(members) }),
});

export function isWriter(value: unknown): value is WriterDefinition {
  return hasMarker(value, WriterMarker);
}

export function isWriterBinding(value: unknown): value is WriterBinding {
  return isBindableBinding(value, WriterBindingMarker, "writer", isWriter);
}

export function isWriterComposition(value: unknown): value is WriterComposition {
  return hasMarker(value, WriterCompositionMarker);
}
