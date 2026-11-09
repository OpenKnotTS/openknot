import type { Event, ErrorOf } from "../src/index.ts";
import { error, failure, operation, reader, standalone, success } from "../src/index.ts";
import { override } from "@openknot-ts/wire";
import type { Application, Resolved } from "@openknot-ts/wire";
import "../src/wire.ts";

interface State {
  readonly id: string;
  readonly name: string;
}
interface Renamed extends Event {
  readonly type: "Renamed";
  readonly name: string;
}
interface Removed extends Event<"Removed"> {
  readonly id: string;
}
const Missing = error("Missing");
type Missing = ReturnType<typeof Missing>;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T>(_value: T): void {}

expectType<Equal<Removed["type"], "Removed">>(true);
expectType<Equal<Event["type"], string>>(true);

const find = reader<(id: string) => Promise<State | null>>();
const rename = operation<{ readonly id: string; readonly name: string }, unknown, Renamed | Removed>()({
  requirements: { find },
  run: async (input, ctx) => {
    expectType<string>(input.id);
    const state = await ctx.find(input.id);
    if (state === null) {
      return failure(Missing());
    }
    return success({
      output: { changeType: "updated", next: { ...state, name: input.name } },
      events: [{ type: "Renamed", name: input.name }],
    });
  },
});
const quiet = operation<State>()({
  run: (state) => success({ output: { changeType: "created", next: state } }),
});
const emptyEvents = operation<void, number, Renamed>()({
  run: () => success({ output: { changeType: "updated", next: 1 }, events: [] }),
});

export async function verifyOperationContract(app: Application): Promise<void> {
  const standaloneRename = standalone(rename, [override(find, () => Promise.resolve(null))]);
  expectType<Equal<ErrorOf<Awaited<ReturnType<typeof standaloneRename>>>, Missing>>(true);
  const wired: Resolved<typeof rename> = app.resolve(rename);
  for (const run of [standaloneRename, wired]) {
    const result = await run({ id: "id", name: "Name" });
    if (result.isError) {
      continue;
    }
    expectType<State>(result.value.output.next);
    expectType<"updated">(result.value.output.changeType);
    expectType<readonly (Renamed | Removed)[]>(result.value.events);
    for (const event of result.value.events) {
      if (event.type === "Renamed") {
        expectType<string>(event.name);
      } else {
        expectType<string>(event.id);
      }
    }
    // @ts-expect-error result event arrays are immutable
    result.value.events.push({ type: "Removed", id: "id" });
  }
  const noEvents = await standalone(quiet)({ id: "id", name: "Name" });
  if (!noEvents.isError) {
    // @ts-expect-error an operation without an event contract has no events result field
    void noEvents.value.events;
  }
  const declaredButEmpty = await standalone(emptyEvents)();
  if (!declaredButEmpty.isError) {
    expectType<Equal<typeof declaredButEmpty.value.events, readonly Renamed[]>>(true);
  }
}

// @ts-expect-error undeclared events are rejected even when returned through a variable
operation({ run: () => success({ output: { changeType: "created", next: 1 }, events: [] }) });
// @ts-expect-error a declared event contract requires an array, including on branches with no events
operation<void, number, Renamed>()({ run: () => success({ output: { changeType: "updated", next: 1 } }) });
operation<void, number, Renamed>()({
  // @ts-expect-error unlisted event types cannot escape the operation
  run: () => success({ output: { changeType: "updated", next: 1 }, events: [{ type: "Removed", id: "id" }] }),
});
operation<void, number, Renamed>()({
  // @ts-expect-error allowed events must include their declared payload
  run: () => success({ output: { changeType: "updated", next: 1 }, events: [{ type: "Renamed" }] }),
});
// @ts-expect-error base events require a string discriminator
operation<void, unknown, { readonly name: string }>();
// @ts-expect-error event generics describe elements; the result events field supplies the array
operation<void, unknown, Renamed[]>();
// @ts-expect-error operations cannot return arbitrary read values
operation({ run: () => success({ output: 1 }) });
// @ts-expect-error change types are fixed
operation({ run: () => success({ output: { changeType: "custom", next: 1 } }) });
// @ts-expect-error created changes must include their next state
operation({ run: () => success({ output: { changeType: "created" } }) });
// @ts-expect-error deletion requires previous instead of next
operation<State>()({ run: (state) => success({ output: { changeType: "deleted", next: state } }) });
// @ts-expect-error a parent must explicitly declare events before forwarding a child's result
operation({ requirements: { emptyEvents }, run: (_input, ctx) => ctx.emptyEvents() });
// @ts-expect-error a plain call takes no input: a declared input goes on the head
operation({ run: (input: string) => success({ output: { changeType: "created", next: input } }) });
// @ts-expect-error a declared state restricts the output
operation<void, string>()({ run: () => success({ output: { changeType: "created", next: 1 } }) });
// @ts-expect-error the empty call carries the declared types, so leaving it out does not compile
operation<State, State>({ run: (state: State) => success({ output: { changeType: "created", next: state } }) });

const remove = operation<State, State, Removed>()({
  run: (state) =>
    success({ output: { changeType: "deleted", previous: state }, events: [{ type: "Removed", id: state.id }] }),
});
export async function verifyDeletion(): Promise<void> {
  const result = await standalone(remove)({ id: "id", name: "Name" });
  if (!result.isError) {
    expectType<State>(result.value.output.previous);
    // @ts-expect-error deletion has no next state
    void result.value.output.next;
  }
}
