import type { ErrorOf, Event, OperationDraft } from "../src/index.ts";
import { created, error, failure, operation, reader, standalone, success, unchanged, updated } from "../src/index.ts";
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

// A list carries changes of the same state, each with its own change type.
const merge = operation<readonly State[], State, Changed>()({
  run: ([kept, merged]) =>
    success({
      output: [
        { changeType: "updated", next: kept! },
        { changeType: "deleted", previous: merged! },
      ],
      events: [{ type: "Changed", name: kept!.name }],
    }),
});
export async function verifyChangeList(input: readonly State[]): Promise<void> {
  const merged = await standalone(merge)(input);
  if (!merged.isError) {
    for (const change of merged.value.output) {
      expectType<State>(change.changeType === "deleted" ? change.previous : change.next);
    }
    expectType<readonly Changed[]>(merged.value.events);
  }
}
// A list's contents are known only at runtime, which refuses events from a list without changes.
operation<State, State, Changed>()({ run: (current) => success({ output: [unchanged(current)], events: [] }) });
operation<State, State, Changed>()({ run: () => success({ output: [], events: [] }) });
operation<State, State>()({
  // @ts-expect-error every change in the list carries the declared state
  run: (current) => success({ output: [updated(current), updated(1)] }),
});

// Created and updated are separate members, yet either one may carry the declared events.
const save = operation<{ readonly state: State; readonly isNew: boolean }, State, Changed>()({
  run: ({ state, isNew }) =>
    success({ output: isNew ? created(state) : updated(state), events: [{ type: "Changed", name: state.name }] }),
});
operation<{ readonly state: State; readonly isNew: boolean }, State, Changed>()({
  run: ({ state, isNew }) =>
    success({
      output: isNew ? { changeType: "created", next: state } : { changeType: "updated", next: state },
      events: [{ type: "Changed", name: state.name }],
    }),
});
export async function verifySave(input: { readonly state: State; readonly isNew: boolean }): Promise<void> {
  const saved = await standalone(save)(input);
  if (!saved.isError) {
    expectType<State>(saved.value.output.next);
    expectType<readonly Changed[]>(saved.value.events);
  }
}
operation<{ readonly state: State; readonly isNew: boolean }, State, Changed>()({
  run: ({ state, isNew }) =>
    // @ts-expect-error a result that may be unchanged cannot publish declared events
    success({ output: isNew ? created(state) : unchanged(state), events: [{ type: "Changed", name: state.name }] }),
});
const unchangedList: OperationDraft<readonly { readonly changeType: "unchanged"; readonly current: State }[], Changed> =
  {
    output: [{ changeType: "unchanged", current: { id: "id", name: "Name" } }],
    // @ts-expect-error a list of only unchanged outputs cannot publish declared events
    events: [{ type: "Changed", name: "Name" }],
  };
void unchangedList;
operation<State, State, Changed>()({
  run: (current) =>
    // @ts-expect-error a created output cannot also carry a previous state
    success({
      output: { changeType: "created", next: current, previous: current },
      events: [{ type: "Changed", name: current.name }],
    }),
});
