import type { Outcome } from "../src/index.ts";
import {
  error,
  standalone,
  failure,
  InternalBehaviorError,
  BehaviorBindingError,
  model,
  operation,
  reader,
  success,
} from "../src/index.ts";
import { override } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const InvalidRoleError = error("InvalidRole");
type InvalidRoleError = ReturnType<typeof InvalidRoleError>;

interface RoleState {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "inactive";
}

function roleModel(onCheck: () => void = () => undefined) {
  return model<RoleState>()({
    name: "role",
    invariants: (state: RoleState): Outcome<void, InvalidRoleError> => {
      onCheck();
      return state.name.length === 0 ? failure(InvalidRoleError("A role requires a name")) : success();
    },
    mutations: {
      rename: (role: RoleState, name: string) => success({ ...role, name }),
      deactivate: (role: RoleState) => success({ ...role, status: "inactive" as const }),
    },
  });
}

describe("model mutations", () => {
  it("changes its own state, preserves the original and checks invariants", () => {
    let checks = 0;
    const Role = roleModel(() => {
      checks += 1;
    });
    const original: RoleState = Object.freeze({ id: "r1", name: "Supervisor", status: "active" });
    const renamed = Role.rename(original, "Dispatcher");
    assert.ok(!renamed.isError);
    assert.equal(renamed.value.name, "Dispatcher");
    assert.notEqual(renamed.value, original);
    assert.equal(original.name, "Supervisor");
    assert.equal(checks, 1);
    assert.deepEqual(Object.keys(renamed.value), ["id", "name", "status"]);
    const rejected = Role.rename(original, "");
    assert.ok(rejected.isError);
    assert.ok(InvalidRoleError.is(rejected.error));
    assert.equal(checks, 2);
    const deactivated = Role.deactivate(original);
    assert.ok(!deactivated.isError);
    assert.equal(deactivated.value.status, "inactive");
    assert.equal(original.status, "active");
    assert.equal(checks, 3);
  });

  it("exposes checked mutations directly on an immutable model, without an mutations wrapper", () => {
    const cause = new Error("mutation defect");
    const options = {
      name: "counter",
      mutations: {
        increment: (value: number) => success(value + 1),
        crash: (): Outcome<number> => {
          throw cause;
        },
      },
    };
    const Counter = model<number>()(options);
    options.name = "changed";
    options.mutations.increment = (value) => success(value + 100);

    assert.equal(Counter.name, "counter");
    assert.equal(Object.hasOwn(Counter, "mutations"), false);
    assert.ok(Object.isFrozen(Counter));
    assert.deepEqual(Counter.increment(1), success(2));
    assert.throws(
      () => Counter.crash(),
      (error) => InternalBehaviorError.is(error) && error.cause === cause && error.boundary === "counter.crash",
    );
  });

  it("rejects mutation names that would overwrite model metadata", () => {
    assert.throws(
      () =>
        Reflect.apply(model<number>(), undefined, [
          {
            name: "counter",
            mutations: { name: () => success(1) },
          },
        ]),
      /mutation 'name'.*diagnostic name/,
    );
  });

  it("forwards declared mutation failures without running invariants", () => {
    let checks = 0;
    const error = InvalidRoleError("Not allowed");
    const Role = model<RoleState>()({
      name: "role",
      invariants: (_state: RoleState) => {
        checks += 1;
        return success();
      },
      mutations: { reject: (_role: RoleState) => failure(error) },
    });
    const result = Role.reject({ id: "r1", name: "Role", status: "active" });
    assert.ok(result.isError);
    assert.equal(result.error, error);
    assert.equal(checks, 0);
  });

  it("contains unexpected failures in mutations and invariants, including non-Error throws", () => {
    const cause = { reason: "invariant defect" };
    const Role = model<RoleState>()({
      name: "role",
      invariants: (_state: RoleState): Outcome<void> => {
        throw cause;
      },
      mutations: { rename: (role: RoleState) => success(role) },
    });
    assert.throws(
      () => Role.rename({ id: "r1", name: "Role", status: "active" }),
      (error) => InternalBehaviorError.is(error) && error.cause === cause && error.boundary === "role.rename",
    );
    const crashing = model<RoleState>()({
      name: "crashing",
      mutations: {
        change: (): Outcome<RoleState> => {
          throw new Error("bug");
        },
      },
    });
    assert.throws(() => crashing.change(), InternalBehaviorError.is);
  });

  it("allows models without invariants", () => {
    const Counter = model<number>()({
      name: "counter",
      mutations: { increment: (value: number) => success(value + 1) },
    });
    assert.deepEqual(Counter.increment(1), success(2));
  });

  it("rejects invalid async model mutations without an unhandled rejection", async () => {
    const asyncAction = (() => Promise.reject(new Error("invalid async model"))) as unknown as () => Outcome<number>;
    const Counter = model<number>()({ name: "counter", mutations: { increment: asyncAction } });
    assert.throws(() => Counter.increment(), InternalBehaviorError.is);
    await setImmediate();
  });

  it("keeps mutations and invariants synchronous and observes invalid promise-like rejections", async () => {
    const invalidResults = [
      () => Promise.reject(new Error("async invariant")),
      (): unknown => runInNewContext('Promise.reject(new Error("thenable rejection"))'),
      () =>
        new Proxy(
          {},
          {
            has(_target, key) {
              return key === "then";
            },
            get(_target, key) {
              if (key === "then") {
                throw new Error("broken then getter");
              }
              return undefined;
            },
          },
        ),
    ];
    for (const invalid of invalidResults) {
      for (const boundary of ["mutation", "invariant"] as const) {
        const Counter = model<number>()({
          name: "counter",
          mutations: { increment: (boundary === "mutation" ? invalid : () => success(1)) as () => Outcome<number> },
          invariants: (boundary === "invariant" ? invalid : () => success()) as (_state: number) => Outcome<void>,
        });
        assert.throws(
          () => Counter.increment(),
          (error) =>
            InternalBehaviorError.is(error) &&
            error.cause instanceof TypeError &&
            error.boundary === "counter.increment",
        );
      }
    }
    await setImmediate();
  });
});

describe("reader bindings", () => {
  it("binds by reference, even for structurally identical signatures", async () => {
    const first = reader<(id: string) => Promise<string>>();
    const second = reader<(id: string) => Promise<string>>();
    const readBoth = operation<string>()({
      requirements: { first, second },
      run: async (id, ctx) =>
        success({
          output: { changeType: "updated" as const, next: [await ctx.first(id), await ctx.second(id)] },
        }),
    });
    const run = standalone(readBoth, [
      override(first, (id) => Promise.resolve(`first:${id}`)),
      override(second, (id) => Promise.resolve(`second:${id}`)),
    ]);
    assert.equal("run" in first, false);
    const result = await run("r1");
    assert.ok(!result.isError);
    assert.deepEqual(result.value.output.next, ["first:r1", "second:r1"]);
  });

  it("keeps implementations isolated across independent binding graphs", async () => {
    const find = reader<() => Promise<string>>();
    const read = operation({
      requirements: { find },
      run: async (_input, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.find() } }),
    });
    const runA = standalone(read, [override(find, () => Promise.resolve("a"))]);
    const runB = standalone(read, [override(find, () => Promise.resolve("b"))]);
    const [a, b] = await Promise.all([runA(), runB()]);
    assert.ok(!a.isError && !b.isError);
    assert.equal(a.value.output.next, "a");
    assert.equal(b.value.output.next, "b");
  });

  it("wraps another execution's internal failure from a reader, while a nested operation keeps its own", async () => {
    const inner = operation({
      tag: "inner",
      run: () => {
        throw new Error("inner defect");
      },
    });
    const foreign = await standalone(inner)().catch((error: unknown) => error);
    assert.ok(InternalBehaviorError.is(foreign));
    const find = reader<() => PromiseLike<number>>();
    const outer = operation<"reader" | "nested">()({
      tag: "outer",
      requirements: { find, inner },
      run: async (source, ctx) => {
        if (source === "nested") {
          await ctx.inner();
        }
        return success({ output: { changeType: "updated" as const, next: await ctx.find() } });
      },
    });
    const shapes = {
      "rejected promise": () => Promise.reject(foreign),
      "rejected thenable": (): PromiseLike<number> => ({
        then: (onFulfilled, onRejected) => Promise.reject<number>(foreign).then(onFulfilled, onRejected),
      }),
      throw: () => {
        throw foreign;
      },
    };
    for (const [shape, implementation] of Object.entries(shapes)) {
      const run = standalone(outer, [override(find, implementation)]);
      await assert.rejects(
        run("reader"),
        (error) => InternalBehaviorError.is(error) && error.boundary === "outer" && error.cause === foreign,
        shape,
      );
      await assert.rejects(
        run("nested"),
        (error) => InternalBehaviorError.is(error) && error.boundary === "inner",
        shape,
      );
    }
  });

  it("rejects missing, duplicate and wrong-identity bindings before execution", () => {
    let calls = 0;
    const required = reader<() => string>();
    const unrelated = reader<() => string>();
    const child = operation({
      requirements: { required },
      run: (_input, ctx) => {
        calls += 1;
        return success({ output: { changeType: "updated" as const, next: ctx.required() } });
      },
    });
    const parent = operation({
      requirements: { child },
      run: (_input, ctx) => ctx.child(),
    });
    assert.throws(() => standalone(parent), /child -> required/);
    assert.throws(() => standalone(parent, [override(unrelated, () => "wrong")]), BehaviorBindingError.is);
    assert.throws(
      () => standalone(parent, [override(required, () => "a"), override(required, () => "b")]),
      /Multiple implementations/,
    );
    assert.equal(calls, 0);
  });
});

describe("operation execution", () => {
  it("returns a Promise for synchronous behavior without adding undeclared events", async () => {
    const calculate = operation<number>()({
      requirements: {},
      run: (value) => success({ output: { changeType: "updated" as const, next: value * 2 } }),
    });
    const pending = standalone(calculate)(3);
    assert.ok(pending instanceof Promise);
    assert.deepEqual(await pending, success({ output: { changeType: "updated" as const, next: 6 } }));
  });

  it("leaves validation in run and preserves typed Error instances and their stack", async () => {
    const error = InvalidRoleError("Invalid role");
    const reject = operation<string>()({ requirements: {}, run: (_input) => failure(error) });
    const result = await standalone(reject)("");
    assert.ok(result.isError);
    assert.equal(result.error, error);
    assert.ok(result.error.stack?.includes("Invalid role"));
  });

  it("executes conditional reads only on the branch that needs them", async () => {
    let reads = 0;
    const find = reader<() => Promise<number>>();
    const calculate = operation<boolean>()({
      requirements: { find },
      run: async (needsRead, ctx) =>
        success({ output: { changeType: "updated" as const, next: needsRead ? await ctx.find() : 0 } }),
    });
    const run = standalone(calculate, [
      override(find, () => {
        reads += 1;
        return Promise.resolve(42);
      }),
    ]);
    await run(false);
    assert.equal(reads, 0);
    const result = await run(true);
    assert.equal(reads, 1);
    assert.ok(!result.isError);
    assert.equal(result.value.output.next, 42);
  });

  it("captures synchronous throws and awaited reader rejections with the original cause", async () => {
    const cause = new Error("database unavailable");
    const find = reader<() => Promise<string>>();
    const read = operation({
      requirements: { find },
      run: async (_input, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.find() } }),
    });
    await assert.rejects(
      standalone(read, [override(find, () => Promise.reject(cause))])(),
      (error) => InternalBehaviorError.is(error) && error.cause === cause,
    );
    const crash = operation({
      requirements: {},
      run: (_input): Outcome<never> => {
        throw "bug";
      },
    });
    await assert.rejects(standalone(crash)(), (error) => InternalBehaviorError.is(error) && error.cause === "bug");
  });

  it("keeps an internal failure that nested behavior throws again instead of wrapping it twice", async () => {
    const Counter = model<number>()({
      name: "Counter",
      mutations: {
        increment: (value: number) => {
          if (value < 0) {
            throw new RangeError("negative counter");
          }
          return success(value + 1);
        },
      },
    });
    const increment = operation<number>()({
      run: (value) => {
        const result = Counter.increment(value);
        if (result.isError) {
          throw result.error;
        }
        return success({ output: { changeType: "updated" as const, next: result.value } });
      },
    });
    await assert.rejects(
      standalone(increment)(-1),
      (error) =>
        InternalBehaviorError.is(error) && error.boundary === "Counter.increment" && error.cause instanceof RangeError,
    );
  });

  it("produces events in the operation only after the model mutation succeeds", async () => {
    const Role = roleModel();
    let emitted = 0;
    const rename = operation<
      { readonly role: RoleState; readonly name: string },
      unknown,
      { readonly type: "RoleRenamed" }
    >()({
      requirements: {},
      run: ({ role, name }) => {
        const result = Role.rename(role, name);
        if (result.isError) {
          return result;
        }
        emitted += 1;
        return success({
          output: { changeType: "updated" as const, next: result.value },
          events: [{ type: "RoleRenamed" as const, id: role.id }],
        });
      },
    });
    const run = standalone(rename);
    const role: RoleState = { id: "r1", name: "Old", status: "active" };
    const bad = await run({ role, name: "" });
    assert.ok(bad.isError);
    assert.equal(emitted, 0);
    const good = await run({ role, name: "New" });
    assert.ok(!good.isError);
    assert.equal(good.value.output.next.name, "New");
    assert.deepEqual(good.value.events, [{ type: "RoleRenamed", id: "r1" }]);
    assert.equal(emitted, 1);
  });

  it("resolves child operations and combines their results and events explicitly", async () => {
    const child = operation<string, unknown, { readonly type: "Deleted" }>()({
      requirements: {},
      run: (id) =>
        success({
          output: { changeType: "deleted" as const, previous: { id, name: "snapshot" } },
          events: [{ type: "Deleted" as const }],
        }),
    });
    const parent = operation<string, unknown, { readonly type: "Deleted" | "ParentCompleted" }>()({
      requirements: { child },
      run: async (id, ctx) => {
        const result = await ctx.child(id);
        if (result.isError) {
          return result;
        }
        return success({
          output: { changeType: "updated" as const, next: [result.value.output] },
          events: [...result.value.events, { type: "ParentCompleted" as const }],
        });
      },
    });
    const result = await standalone(parent)("r1");
    assert.ok(!result.isError);
    assert.deepEqual(result.value.output.next, [{ changeType: "deleted", previous: { id: "r1", name: "snapshot" } }]);
    assert.deepEqual(result.value.events, [{ type: "Deleted" }, { type: "ParentCompleted" }]);
  });

  it("does not silently accumulate child events", async () => {
    const child = operation<void, number, { readonly type: "Child" }>()({
      requirements: {},
      run: (_input) => success({ output: { changeType: "updated" as const, next: 1 }, events: [{ type: "Child" }] }),
    });
    const parent = operation({
      requirements: { child },
      run: async (_input, ctx) => {
        const result = await ctx.child();
        if (result.isError) {
          return result;
        }
        return success({ output: result.value.output });
      },
    });
    const result = await standalone(parent)();
    assert.ok(!result.isError);
    assert.equal(Object.hasOwn(result.value, "events"), false);
  });

  it("preserves reader Outcomes rather than silently unwrapping expected failures", async () => {
    const expected = InvalidRoleError("read rejected");
    const find = reader<() => Promise<Outcome<string, InvalidRoleError>>>();
    const read = operation({
      requirements: { find },
      run: async (_input, ctx) => {
        const result = await ctx.find();
        if (result.isError) {
          return result;
        }
        return success({ output: { changeType: "updated" as const, next: result.value } });
      },
    });
    const result = await standalone(read, [override(find, () => Promise.resolve(failure(expected)))])();
    assert.ok(result.isError);
    assert.equal(result.error, expected);
  });

  it("copies the event envelope without mutating author-owned arrays", async () => {
    const events = [{ type: "Changed" }];
    const change = operation<void, number, (typeof events)[number]>()({
      requirements: {},
      run: (_input) => success({ output: { changeType: "updated" as const, next: 1 }, events }),
    });
    const result = await standalone(change)();
    assert.ok(!result.isError);
    events.push({ type: "Later" });
    assert.deepEqual(result.value.events, [{ type: "Changed" }]);
    assert.ok(Object.isFrozen(result.value.events));
    assert.ok(Object.isFrozen(result.value));
  });

  it("contains malformed results from untyped execution code", async () => {
    const malformed = (() => success(42)) as unknown as () => Outcome<{
      readonly output: { readonly changeType: "updated"; readonly next: number };
    }>;
    const invalid = operation({ requirements: {}, run: malformed });
    await assert.rejects(
      standalone(invalid)(),
      (error) => InternalBehaviorError.is(error) && error.cause instanceof TypeError,
    );
  });
});
