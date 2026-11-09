import type { ErrorOf, OperationDraft, OperationOutput, Outcome } from "../src/index.ts";
import { error, standalone, failure, model, operation, reader, success } from "../src/index.ts";
import { plug, override } from "@openknot-ts/wire";

const InvalidRoleError = error("InvalidRole");
type InvalidRoleError = ReturnType<typeof InvalidRoleError>;
const MissingRoleError = error("MissingRole");
type MissingRoleError = ReturnType<typeof MissingRoleError>;
const RoleInUseError = error("RoleInUse");
type RoleInUseError = ReturnType<typeof RoleInUseError>;
interface RoleState {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "inactive";
}

function expectType<T>(_value: T): void {}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compile-only API contracts. This function is never executed. */
export async function verifyBehaviorTypes(): Promise<void> {
  const find = reader<(id: string) => Promise<RoleState | null>>();
  // @ts-expect-error a binding must preserve the reader's parameter and result types
  plug({ port: find, bind: () => (id: number) => Promise.resolve(id) });
  // @ts-expect-error a definition has no executable implementation
  find.run("id");
  const Role = model<RoleState>()({
    name: "role",
    invariants: (role: RoleState): Outcome<void, InvalidRoleError> =>
      role.name ? success() : failure(InvalidRoleError()),
    mutations: {
      rename: (role: RoleState, name: string) => success({ ...role, name }),
      deactivate: (role: RoleState) => success({ ...role, status: "inactive" as const }),
      reject: (_role: RoleState) => failure(RoleInUseError()),
    },
  });
  const state: RoleState = { id: "r1", name: "Role", status: "active" };
  const renamed = Role.rename(state, "New");
  expectType<Outcome<RoleState, InvalidRoleError>>(renamed);
  const deactivated = Role.deactivate(state);
  if (!deactivated.isError) {
    expectType<RoleState>(deactivated.value);
  }
  const rejected = Role.reject(state);
  if (rejected.isError) {
    expectType<RoleInUseError | InvalidRoleError>(rejected.error);
  }
  // @ts-expect-error model mutations preserve their original parameters
  Role.rename(state, 42);
  // @ts-expect-error returned model mutations are immutable
  Role.rename = (role: RoleState) => success(role);
  // @ts-expect-error checked model mutations are exposed directly, without a wrapper
  Role.mutations.rename(state, "New");
  expectType<string | undefined>(Role.name);
  const metadataCollision = { name: "bad", mutations: { name: () => success(state) } };
  // @ts-expect-error mutation names cannot overwrite model metadata
  model<RoleState>()(metadataCollision);
  const invalidModelOptions = {
    name: "bad",
    invariants: (_role: RoleState) => success(),
    mutations: {
      bad: () => success(123),
    },
  };
  // @ts-expect-error mutation output must match the model invariant's state type
  model<RoleState>()(invalidModelOptions);
  model<RoleState>()({
    name: "async",
    mutations: {
      // @ts-expect-error model mutations are synchronous; async business flows belong in operations
      bad: async (role: RoleState) => role,
    },
  });
  const rename = operation<{ readonly id: string; readonly name: string }, unknown, { readonly type: "RoleRenamed" }>()(
    {
      requirements: { find },
      run: async ({ id, name }, ctx) => {
        expectType<(id: string) => Promise<RoleState | null>>(ctx.find);
        // @ts-expect-error context exposes exactly the declared requirements
        void ctx.database;
        // @ts-expect-error reader parameters remain typed in the operation context
        ctx.find.run(123);
        const role = await ctx.find(id);
        if (role === null) {
          return failure(MissingRoleError());
        }
        const changed = Role.rename(role, name);
        if (changed.isError) {
          return changed;
        }
        return success({
          output: { changeType: "updated" as const, next: changed.value },
          events: [{ type: "RoleRenamed" as const }],
        });
      },
    },
  );
  const run = standalone(rename, [override(find, () => Promise.resolve(state))]);
  expectType<Equal<ErrorOf<Awaited<ReturnType<typeof run>>>, MissingRoleError | InvalidRoleError>>(true);
  // @ts-expect-error operation input is derived from the run signature
  run({ id: 123, name: "Wrong" });
  const result = await run({ id: "r1", name: "New" });
  if (result.isError) {
    expectType<MissingRoleError | InvalidRoleError>(result.error);
    // @ts-expect-error the error union must not silently widen to Error
    expectType<RoleInUseError>(result.error);
  } else {
    expectType<OperationOutput<RoleState>>(result.value.output);
    expectType<readonly { readonly type: "RoleRenamed" }[]>(result.value.events);
    // @ts-expect-error event literals must be preserved
    expectType<readonly { readonly type: "OtherEvent" }[]>(result.value.events);
  }
  const parent = operation<string, unknown, { readonly type: "RoleRenamed" }>()({
    requirements: { rename },
    run: async (id, ctx) => {
      const changed = await ctx.rename({ id, name: "New" });
      if (changed.isError) {
        return changed;
      }
      return success({ output: changed.value.output, events: changed.value.events });
    },
  });
  const parentResult = await standalone(parent, [override(find, () => Promise.resolve(state))])("r1");
  if (parentResult.isError) {
    expectType<MissingRoleError | InvalidRoleError>(parentResult.error);
  } else {
    expectType<"updated">(parentResult.value.output.changeType);
  }
  const calculate = operation<number>()({
    requirements: {},
    run: (value) => success({ output: { changeType: "updated" as const, next: value * 2 } }),
  });
  const noInput = operation({
    requirements: {},
    run: () => success({ output: { changeType: "updated" as const, next: 42 } }),
  });
  await standalone(noInput)();
  const calculated = await standalone(calculate)(2);
  if (!calculated.isError) {
    expectType<number>(calculated.value.output.next);
    // @ts-expect-error no event type was declared
    void calculated.value.events;
  }
  const annotated = operation<void, number, { readonly type: "ExplicitEvent" }>()({
    requirements: {},
    run: (): Outcome<
      OperationDraft<{ readonly changeType: "updated"; readonly next: number }, { readonly type: "ExplicitEvent" }>
    > => success({ output: { changeType: "updated" as const, next: 1 }, events: [] }),
  });
  const annotatedResult = await standalone(annotated)();
  if (!annotatedResult.isError) {
    expectType<Equal<typeof annotatedResult.value.events, readonly { readonly type: "ExplicitEvent" }[]>>(true);
  }
  const remove = operation({
    run: () => success({ output: { changeType: "deleted", previous: state } }),
  });
  const removed = await standalone(remove)();
  if (!removed.isError) {
    expectType<RoleState>(removed.value.output.previous);
  }
  // @ts-expect-error an operation returns Outcome, rather than a raw result
  operation<number>()({ requirements: {}, run: (value) => value });
}

// @ts-expect-error A describer cannot return the error's own name; its type names it.
error("NameTaken", (name: string) => ({ message: `${name} is taken`, name }));
