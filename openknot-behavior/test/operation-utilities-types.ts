import type {
  Event,
  ErrorOf,
  OperationErrors,
  OperationEvents,
  OperationInput,
  OperationOutput,
} from "../src/index.ts";
import {
  error,
  created,
  deleted,
  failure,
  operation,
  reader,
  standalone,
  success,
  unchanged,
  updated,
} from "../src/index.ts";
import { override } from "@openknot-ts/wire";

interface State {
  readonly id: string;
  readonly name: string;
}
type StateEvent = Event &
  ({ readonly type: "Created"; readonly state: State } | { readonly type: "Updated"; readonly state: State });
const Missing = error("Missing");
type Missing = ReturnType<typeof Missing>;
function expectType<T>(_value: T): void {}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const find = reader<(id: string) => Promise<State | null>>();
const rename = operation<State, State, StateEvent>()({
  requirements: { find },
  run: async (input, ctx) => {
    const current = await ctx.find(input.id);
    if (current === null) {
      return failure(Missing());
    }
    if (current.name === input.name) {
      return success({ output: unchanged(current), events: [] });
    }
    return success({ output: updated(input), events: [{ type: "Updated", state: input }] });
  },
});
const quiet = operation<number>()({ run: (next) => success({ output: created(next) }) });
const idle = operation<State, State, StateEvent>()({
  run: (current) => success({ output: unchanged(current), events: [] }),
});
const rejected = operation<void, State, StateEvent>()({ run: () => failure(Missing()) });
const remove = operation<State>()({ run: (previous) => success({ output: deleted(previous) }) });

expectType<Equal<OperationInput<typeof rename>, State>>(true);
expectType<Equal<OperationEvents<typeof rename>, StateEvent>>(true);
expectType<Equal<OperationInput<typeof quiet>, number>>(true);
expectType<Equal<OperationEvents<typeof quiet>, never>>(true);
expectType<Equal<OperationEvents<typeof idle>, StateEvent>>(true);
expectType<Equal<OperationInput<typeof rejected>, void>>(true);
expectType<Equal<OperationEvents<typeof rejected>, StateEvent>>(true);
expectType<Equal<OperationInput<typeof rename | typeof quiet>, State | number>>(true);
expectType<Equal<OperationEvents<typeof rename | typeof quiet>, StateEvent>>(true);
expectType<Equal<OperationInput<never>, never>>(true);
// Authored errors come from the definition, as a handler's do.
expectType<Equal<OperationErrors<typeof rename>, Missing>>(true);
expectType<Equal<OperationErrors<typeof quiet>, never>>(true);
expectType<Equal<OperationEvents<never>, never>>(true);

export async function verifyHelperTypes(state: State): Promise<void> {
  expectType<"created">(created(state).changeType);
  expectType<"updated">(updated(state).changeType);
  expectType<"deleted">(deleted(state).changeType);
  expectType<"unchanged">(unchanged(state).changeType);
  expectType<State>(created(state).next);
  expectType<State>(updated(state).next);
  expectType<State>(deleted(state).previous);
  expectType<State>(unchanged(state).current);
  expectType<OperationOutput<State>>(updated(state));
  // @ts-expect-error helper descriptors are immutable
  updated(state).next = state;
  // @ts-expect-error deleted descriptors have no next state
  void deleted(state).next;
  // @ts-expect-error unchanged descriptors have no next state
  void unchanged(state).next;
  const run = standalone(rename, [override(find, () => Promise.resolve(state))]);
  expectType<Equal<ErrorOf<Awaited<ReturnType<typeof run>>>, Missing>>(true);
  const result = await run(state);
  if (!result.isError) {
    if (result.value.output.changeType === "unchanged") {
      expectType<State>(result.value.output.current);
    } else {
      expectType<State>(result.value.output.next);
    }
    type Idle = Extract<typeof result.value, { readonly output: { readonly changeType: "unchanged" } }>;
    expectType<Equal<Idle["events"], readonly never[]>>(true);
  }
  const removed = await standalone(remove)(state);
  if (!removed.isError) {
    expectType<State>(removed.value.output.previous);
    // @ts-expect-error helpers do not add an undeclared event contract
    void removed.value.events;
  }
}

operation<State, State, StateEvent>()({
  // @ts-expect-error unchanged helpers still forbid nonempty event arrays
  run: (current) => success({ output: unchanged(current), events: [{ type: "Updated", state: current }] }),
});
// @ts-expect-error helpers do not enable events when no generic was declared
operation<State>()({ run: (next) => success({ output: updated(next), events: [] }) });
operation<State, State, StateEvent>()({
  // @ts-expect-error allowed event discriminators remain enforced with helpers
  run: (next) => success({ output: updated(next), events: [{ type: "Wrong", state: next }] }),
});
operation<State, State, StateEvent>()({
  // @ts-expect-error allowed event payloads remain enforced with helpers
  run: (next) => success({ output: created(next), events: [{ type: "Created" }] }),
});
// @ts-expect-error input extraction requires an operation definition
export type InvalidInput = OperationInput<typeof find>;
// @ts-expect-error event extraction requires an operation definition
export type InvalidEvents = OperationEvents<typeof find>;
// @ts-expect-error factories have no operation contract until configured
export type UnconfiguredInput = OperationInput<ReturnType<typeof operation<State>>>;
const executeQuiet = standalone(quiet);
// @ts-expect-error executable functions are not operation definitions
export type ExecutableEvents = OperationEvents<typeof executeQuiet>;
