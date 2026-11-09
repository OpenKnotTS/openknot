import type { ErrorOf, Event, OperationDraft } from "../src/index.ts";
import { error, failure, operation, reader, standalone, success } from "../src/index.ts";
import { override } from "@openknot-ts/wire";
import type { Application } from "@openknot-ts/wire";
import "../src/wire.ts";

interface State {
  readonly id: string;
  readonly name: string;
}
interface Changed extends Event {
  readonly type: "Changed";
  readonly name: string;
}
const Missing = error("Missing");
type Missing = ReturnType<typeof Missing>;
function expectType<T>(_value: T): void {}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const find = reader<(id: string) => Promise<State | null>>();
const rename = operation<State, State, Changed>()({
  requirements: { find },
  run: async (input, ctx) => {
    const state = await ctx.find(input.id);
    if (state === null) {
      return failure(Missing());
    }
    return input.name === state.name
      ? success({ output: { changeType: "unchanged", current: state }, events: [] })
      : success({ output: { changeType: "updated", next: input }, events: [{ type: "Changed", name: input.name }] });
  },
});
const declared = operation<State, State, Changed>()({
  run: (current) => success({ output: { changeType: "unchanged", current }, events: [] }),
});
const quiet = operation<State>()({ run: (current) => success({ output: { changeType: "unchanged", current } }) });

export async function verifyUnchanged(app: Application, input: State): Promise<void> {
  const run = standalone(rename, [override(find, () => Promise.resolve(null))]);
  expectType<Equal<ErrorOf<Awaited<ReturnType<typeof run>>>, Missing>>(true);
  for (const execute of [run, app.resolve(rename)]) {
    const result = await execute(input);
    if (result.isError) {
      continue;
    }
    if (result.value.output.changeType === "unchanged") {
      expectType<State>(result.value.output.current);
      // @ts-expect-error unchanged results have no next state
      void result.value.output.next;
    } else {
      expectType<State>(result.value.output.next);
      // @ts-expect-error updated results have no current state
      void result.value.output.current;
    }
    type Unchanged = Extract<typeof result.value, { readonly output: { readonly changeType: "unchanged" } }>;
    expectType<Equal<Unchanged["events"], readonly never[]>>(true);
  }
  const empty = await standalone(declared)(input);
  if (!empty.isError) {
    expectType<Equal<typeof empty.value.events, readonly never[]>>(true);
  }
  const noEvents = await standalone(quiet)(input);
  if (!noEvents.isError) {
    expectType<State>(noEvents.value.output.current);
    // @ts-expect-error an omitted event contract still means no events field
    void noEvents.value.events;
  }
}

operation<State, State, Changed>()({
  run: (current) =>
    // @ts-expect-error unchanged cannot publish declared events
    success({ output: { changeType: "unchanged", current }, events: [{ type: "Changed", name: "Name" }] }),
});
// @ts-expect-error unchanged still needs an empty array when events were declared
operation<State, State, Changed>()({ run: (current) => success({ output: { changeType: "unchanged", current } }) });
// @ts-expect-error no event generic forbids even an empty array
operation<State>()({ run: (current) => success({ output: { changeType: "unchanged", current }, events: [] }) });
// @ts-expect-error unchanged requires current
operation({ run: () => success({ output: { changeType: "unchanged" } }) });
// @ts-expect-error unchanged cannot contain a next state
operation<State>()({ run: (current) => success({ output: { changeType: "unchanged", current, next: current } }) });
operation<State>()({
  // @ts-expect-error unchanged cannot contain a previous state
  run: (current) => success({ output: { changeType: "unchanged", current, previous: current } }),
});
const invalid: OperationDraft<{ readonly changeType: "unchanged"; readonly current: State }, Changed> = {
  output: { changeType: "unchanged", current: { id: "id", name: "Name" } },
  // @ts-expect-error this array's type permits events, so it cannot represent a guaranteed empty array
  events: [] as Changed[],
};
void invalid;

// A conditional descriptor is valid when the whole result is guaranteed event-free.
const emptyDecision = operation<{ readonly current: State; readonly changed: boolean }, unknown, Changed>()({
  run: ({ current, changed }) =>
    success({
      output: changed ? { changeType: "updated", next: current } : { changeType: "unchanged", current },
      events: [],
    }),
});
void emptyDecision;
