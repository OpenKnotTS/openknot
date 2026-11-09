import { command, persist, upserted, writer } from "../src/index.ts";
import type { Deleted, Upserted } from "../src/index.ts";
import { created, deleted, updated } from "@openknot-ts/behavior";
import type { Deleted as BehaviorDeleted, OperationOutput, unchanged } from "@openknot-ts/behavior";
import { plug } from "@openknot-ts/wire";
import "../src/wire.ts";

interface State {
  readonly id: string;
}

const save = writer<(state: State) => Promise<Upserted<State>>>();
const remove = writer<(id: string) => Promise<Deleted<State>>>();
const removeId = writer<(id: string) => Promise<Deleted<string>>>();
interface Key {
  readonly tenant: string;
  readonly code: number;
}
const removeKey = writer<(key: Key) => Promise<Deleted<Key>>>();
const group = writer.compose({ save, remove, removeId, removeKey });
plug({
  port: group,
  bind: () => ({
    save: async (state) => upserted(state),
    remove: async (id) => deleted({ id }),
    removeId: async (id) => deleted(id),
    removeKey: async (key) => deleted(key),
  }),
});

command<State>()({
  requirements: { save, remove, removeId, removeKey },
  run: async (state, ctx) => {
    const persisted: Upserted<State> = await ctx.save(state);
    const removed: BehaviorDeleted<State> = await ctx.remove(state.id);
    const next: State = persisted.next;
    const previous: State = removed.previous;
    const removedId: BehaviorDeleted<string> = await ctx.removeId(state.id);
    const previousId: string = removedId.previous;
    const removedKey: BehaviorDeleted<Key> = await ctx.removeKey({ tenant: "tenant", code: 1 });
    const previousKey: Key = removedKey.previous;
    // @ts-expect-error Upserts contain next, not previous.
    void persisted.previous;
    // @ts-expect-error Deletions contain previous, not next.
    void removed.next;
    // @ts-expect-error Write result discriminants are readonly.
    persisted.changeType = "upserted";
    void [next, previous, previousId, previousKey];
    throw new Error("Type-only execution");
  },
});

// @ts-expect-error Persistence writers must return their declared result wrapper.
plug({ port: save, bind: () => async (state) => state });
// @ts-expect-error A declared persistence writer cannot return void.
plug({ port: save, bind: () => async () => {} });
// @ts-expect-error Business creation is not an upsert persistence result.
plug({ port: save, bind: () => async (state) => created(state) });
// @ts-expect-error Business updates are not an upsert persistence result.
plug({ port: save, bind: () => async (state) => updated(state) });
// @ts-expect-error A save writer cannot return a deletion.
plug({ port: save, bind: () => async (state) => deleted(state) });
// @ts-expect-error A delete writer cannot return an upsert.
plug({ port: remove, bind: () => async (id) => upserted({ id }) });
// @ts-expect-error Undefined is not this writer's declared deletion result.
plug({ port: remove, bind: () => async () => undefined });
// @ts-expect-error A scalar deletion payload cannot become an object implicitly.
plug({ port: removeId, bind: () => async (id) => deleted({ id }) });
// @ts-expect-error State payloads retain their declared shape.
plug({ port: save, bind: () => async () => upserted({ id: 1 }) });

// Ordinary non-persistence writers retain their native return types.
plug({ port: writer<(amount: number) => number>(), bind: () => (amount) => amount + 1 });
plug({ port: writer<() => Promise<void>>(), bind: () => async () => {} });

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly version: number;
}
// Managed writers delete with the full state, singly or in arrays.
writer<(role: Role) => Promise<Upserted<Role> | Deleted<Role>>>();
writer<(id: string) => Promise<Deleted<Role>>>();
writer<(roles: readonly Role[]) => Promise<readonly (Upserted<Role> | Deleted<Role>)[]>>();
// @ts-expect-error A managed writer cannot delete by a scalar key.
writer<(role: Role) => Promise<Deleted<string>>>();
// @ts-expect-error A managed writer cannot delete with a partial state.
writer<(roles: readonly Role[]) => Promise<readonly (Upserted<Role> | Deleted<{ readonly id: string }>)[]>>();

// persist() needs a writer for each change the output can carry and returns the persisted state.
const upsertState = async (state: State) => upserted(state);
const deleteState = async (state: State) => deleted(state);
declare const anyChange: OperationOutput<State>;
declare const kept: ReturnType<typeof created<State>> | ReturnType<typeof unchanged<State>>;
declare const removal: ReturnType<typeof deleted<State>>;
const maybeKept: Promise<State | undefined> = persist(anyChange, { upsert: upsertState, delete: deleteState });
const keptState: Promise<State> = persist(kept, { upsert: upsertState });
const removed: Promise<undefined> = persist(removal, { delete: deleteState });
void [maybeKept, keptState, removed];
// @ts-expect-error A deletion persists no state.
const notDeleted: Promise<State> = persist(anyChange, { upsert: upsertState, delete: deleteState });
// @ts-expect-error An output that can delete needs a delete writer.
persist(anyChange, { upsert: upsertState });
// @ts-expect-error An output that can create or update needs an upsert writer.
persist(anyChange, { delete: deleteState });
// A writer the output cannot need is optional but still typed.
persist(kept, { upsert: upsertState, delete: deleteState });
// @ts-expect-error An optional writer keeps its persistence contract.
persist(kept, { upsert: upsertState, delete: async (id: string) => deleted(id) });
// @ts-expect-error The delete writer deletes with the full previous state.
persist(anyChange, { upsert: upsertState, delete: async (id: string) => deleted(id) });
void notDeleted;
