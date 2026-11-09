import type { Outcome } from "../src/index.ts";
import { error, failure, model, success } from "../src/index.ts";

interface State {
  readonly name: string;
  readonly count: number;
}
const InvalidState = error("InvalidState");
type InvalidState = ReturnType<typeof InvalidState>;
const Rejected = error("Rejected");
type Rejected = ReturnType<typeof Rejected>;
function expectType<T>(_value: T): void {}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compile-only shared state, query signatures and method namespace contracts. */
export function verifyModelTypes(): void {
  const Model = model<State>()({
    name: "example",
    invariants: (state) => {
      expectType<Readonly<State>>(state);
      // @ts-expect-error invariants inspect readonly state
      state.name = "Changed";
      return state.count >= 0 ? success() : failure(InvalidState());
    },
    mutations: {
      create: (name: string) => success({ name, count: 0 }),
      reject: () => failure(Rejected()),
    },
    queries: {
      displayName: (state: State) => state.name,
      isNameValid: (name: string) => name.length > 0,
      optional: (_state: State, amount?: number) => amount ?? 0,
      check: () => failure(Rejected()),
    },
  });
  const created = Model.create("Name");
  const exact: Equal<typeof created, Outcome<State, InvalidState>> = true;
  expectType<true>(exact);
  expectType<Outcome<State, Rejected | InvalidState>>(Model.reject());
  expectType<string>(Model.displayName({ name: "Name", count: 0 }));
  expectType<boolean>(Model.isNameValid("Name"));
  expectType<number>(Model.optional({ name: "Name", count: 0 }));
  expectType<Rejected>(Model.check().error);
  // @ts-expect-error query inputs are preserved
  Model.isNameValid(1);
  // @ts-expect-error public query methods are readonly
  Model.isNameValid = () => false;
  // @ts-expect-error mutations and queries share one flat model API
  Model.queries.displayName({ name: "Name", count: 0 });

  model<State>()({ name: "query-only", queries: { isValid: (name: string) => name.length > 0 } });
  const invalidState = { name: "bad", mutations: { change: () => success({ count: 1 }) } };
  // @ts-expect-error mutations must produce the full declared state, even without invariants
  model<State>()(invalidState);
  const collision = {
    name: "bad",
    mutations: { change: () => success({ name: "Name", count: 0 }) },
    queries: { change: () => true },
  };
  // @ts-expect-error query names cannot overwrite mutations
  model<State>()(collision);
  const reserved = { name: "bad", queries: { name: () => "Name" } };
  // @ts-expect-error query names cannot overwrite diagnostic metadata
  model<State>()(reserved);
  const asynchronous = { name: "bad", queries: { value: async () => true } };
  // @ts-expect-error model queries remain synchronous
  model<State>()(asynchronous);
}
