import type { Deleted, Upserted } from "../src/index.ts";
import {
  command,
  InternalFlowError,
  PostCommitError,
  publisher,
  query,
  UnitOfWorkError,
  upserted,
  writer,
} from "../src/index.ts";
import { unitOfWorkChanges } from "../src/wire.ts";
import { application } from "./fixtures/unit-of-work.ts";
import { deleted, error, failure, success } from "@openknot-ts/behavior";
import { VersionConflict } from "@openknot-ts/versioning";
import { plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
  readonly version?: number;
}
const role = (id: string, name: string, version?: number): Role => ({
  entity: "role",
  id,
  name,
  ...(version === undefined ? {} : { version }),
});

const saveRole = writer<(value: Role) => Promise<Upserted<Role>>>();
const saveRoles = writer<(values: readonly Role[]) => Promise<readonly Upserted<Role>[]>>();
const deleteRole = writer<(value: Role) => Promise<Deleted<Role>>>();
const changed = publisher<string>();

function storage(options: { readonly overlap?: number } = {}) {
  const sent: string[] = [];
  let started = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function arrive() {
    started += 1;
    if (started === options.overlap) {
      release();
    }
    if (options.overlap !== undefined) {
      await gate;
    }
  }
  return {
    sent,
    definitions: [
      plug({
        port: saveRole,
        bind: () => async (value) => {
          await arrive();
          return upserted(value.version === undefined ? value : { ...value, version: value.version + 1 });
        },
      }),
      plug({ port: saveRoles, bind: () => async (values) => values.map((value) => upserted(value)) }),
      plug({ port: deleteRole, bind: () => async (value) => deleted(value) }),
      plug({
        port: changed,
        bind: () => async (message) => {
          sent.push(message);
        },
      }),
    ],
  };
}

test("latest returns the final receipt of a managed entity, including a later deletion and bulk writes", async () => {
  const state = storage();
  const change = command({
    requirements: { saveRole, saveRoles, deleteRole, changed },
    run: async (_, ctx) => {
      const saved = await ctx.saveRole(role("r1", "admin"));
      const [bulk] = await ctx.saveRoles([role("r2", "ops")]);
      await ctx.changed.publish(({ latest }) => {
        const final = latest(saved);
        return final.changeType === "upserted" ? final.next.name : `deleted ${final.previous.id}`;
      });
      await ctx.changed.publish(({ latest }) => {
        const final = latest(bulk!);
        return final.changeType === "upserted" ? final.next.name : "deleted";
      });
      await ctx.deleteRole(role("r1", "admin"));
      return success(undefined);
    },
  });
  const app = await application([...state.definitions, change]);
  try {
    const result = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(!result.isError);
    assert.deepEqual(state.sent, ["deleted r1", "ops"]);
  } finally {
    await app.stop();
  }
});

test("receipts without entity and id are not tracked", async () => {
  const state = storage();
  const plain = writer<(name: string) => Promise<Upserted<{ name: string }>>>();
  const change = command({
    requirements: { plain, changed },
    run: async (_, ctx) => {
      const saved = await ctx.plain("admin");
      await ctx.changed.publish(({ latest }) => latest(saved).changeType);
      return success(undefined);
    },
  });
  const plainPlug = plug({ port: plain, bind: () => async (name) => upserted({ name }) });
  const app = await application([...state.definitions, plainPlug, change]);
  try {
    const result = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(result.isError && PostCommitError.is(result.error));
    assert.ok(UnitOfWorkError.is(result.error.cause));
    assert.deepEqual(state.sent, []);
  } finally {
    await app.stop();
  }
});

test("latest() refuses a receipt from another Unit of Work", async () => {
  const state = storage();
  const save = command({
    requirements: { saveRole },
    run: async (_, ctx) => success(await ctx.saveRole(role("r1", "admin"))),
  });
  const announce = command<Upserted<Role>>()({
    requirements: { changed },
    run: async (receipt, ctx) => {
      await ctx.changed.publish(({ latest }) => latest(receipt).changeType);
      return success(undefined);
    },
  });
  const app = await application([...state.definitions, save, announce]);
  try {
    const saved = await app.withScope((scope) => scope.resolve(save)());
    assert.ok(!saved.isError);
    const result = await app.withScope((scope) => scope.resolve(announce)(saved.value));
    assert.ok(result.isError && PostCommitError.is(result.error));
    assert.ok(UnitOfWorkError.is(result.error.cause));
    assert.deepEqual(state.sent, []);
  } finally {
    await app.stop();
  }
});

test("a publication factory may resolve asynchronously, and resolving undefined skips its delivery", async () => {
  const state = storage();
  const change = command({
    requirements: { saveRole, changed },
    run: async (_, ctx) => {
      const saved = await ctx.saveRole(role("r1", "admin"));
      await ctx.changed.publish(async ({ latest }) => {
        const final = latest(saved);
        return final.changeType === "upserted" ? `saved ${final.next.name}` : "deleted";
      });
      await ctx.changed.publish(async () => undefined);
      return success(undefined);
    },
  });
  const app = await application([...state.definitions, change]);
  try {
    const result = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(!result.isError);
    assert.deepEqual(state.sent, ["saved admin"]);
  } finally {
    await app.stop();
  }
});

test("a listener that fails to settle fails committed work after its commit and rolled-back work as its own", async () => {
  const Refused = error("Refused");
  const state = storage();
  const change = command<boolean>()({
    requirements: { saveRole },
    run: async (fail, ctx) => {
      await ctx.saveRole(role("r1", "admin"));
      return fail ? failure(Refused()) : success(undefined);
    },
  });
  const app = await application([...state.definitions, change]);
  try {
    await app.withScope(async (scope) => {
      scope.resolve(unitOfWorkChanges).subscribe({
        recorded() {},
        committed() {},
        settled() {
          throw new Error("settle failed");
        },
      });
      const committed = await scope.resolve(change)(false);
      assert.ok(committed.isError && PostCommitError.is(committed.error));
      assert.equal(committed.error.phase, "changes");
      const rolledBack = await scope.resolve(change)(true);
      assert.ok(rolledBack.isError && UnitOfWorkError.is(rolledBack.error));
      assert.equal(rolledBack.error.transactionStatus, "rolled-back");
    });
  } finally {
    await app.stop();
  }
});

test("overlapping writes fail only for the same unversioned entity", async () => {
  async function run(first: Role, second: Role) {
    const state = storage({ overlap: 2 });
    const both = command({
      requirements: { saveRole },
      run: async (_, ctx) => {
        await Promise.all([ctx.saveRole(first), ctx.saveRole(second)]);
        return success(undefined);
      },
    });
    const app = await application([...state.definitions, both]);
    try {
      return await app.withScope((scope) => scope.resolve(both)());
    } finally {
      await app.stop();
    }
  }
  const sameKey = await run(role("r1", "a"), role("r1", "b"));
  assert.ok(sameKey.isError && UnitOfWorkError.is(sameKey.error));
  assert.ok(!(await run(role("r1", "a"), role("r2", "b"))).isError);
  assert.ok(!(await run(role("r1", "a", 1), role("r1", "b", 2))).isError);
});

test("the highest version stands when overlapping versioned writes finish out of order", async () => {
  const later = Promise.withResolvers<void>();
  const sent: string[] = [];
  const save = plug({
    port: saveRole,
    bind: () => async (value) => {
      if (value.version === 1) {
        await later.promise;
      }
      return upserted({ ...value, version: value.version! + 1 });
    },
  });
  const delivery = plug({
    port: changed,
    bind: () => async (message) => {
      sent.push(message);
    },
  });
  const both = command({
    requirements: { saveRole, changed },
    run: async (_, ctx) => {
      const [first] = await Promise.all([
        ctx.saveRole(role("r1", "a", 1)),
        ctx.saveRole(role("r1", "b", 2)).finally(later.resolve),
      ]);
      await ctx.changed.publish(({ latest }) => {
        const final = latest(first);
        return final.changeType === "upserted" ? String(final.next.version) : undefined;
      });
      return success(undefined);
    },
  });
  const app = await application([save, delivery, both]);
  try {
    assert.ok(!(await app.withScope((scope) => scope.resolve(both)())).isError);
    assert.deepEqual(sent, ["3"]);
  } finally {
    await app.stop();
  }
});

test("a read-only Unit of Work rejects managed receipts", async () => {
  const state = storage();
  const read = query({
    requirements: { saveRole },
    run: async (_, ctx) => success(await ctx.saveRole(role("r1", "admin"))),
  });
  const app = await application([...state.definitions, read]);
  try {
    const result = await app.withScope((scope) => scope.resolve(read)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
  } finally {
    await app.stop();
  }
});

test("nested handlers share one journal", async () => {
  const state = storage();
  const inner = command({
    requirements: { saveRole },
    run: async (_, ctx) => success(await ctx.saveRole(role("r1", "admin"))),
  });
  const outer = command({
    requirements: { inner, deleteRole, changed },
    run: async (_, ctx) => {
      const saved = await ctx.inner();
      if (saved.isError) {
        return saved;
      }
      await ctx.deleteRole(role("r1", "admin"));
      await ctx.changed.publish(({ latest }) => latest(saved.value).changeType);
      return success(undefined);
    },
  });
  const app = await application([...state.definitions, inner, outer]);
  try {
    const result = await app.withScope((scope) => scope.resolve(outer)());
    assert.ok(!result.isError);
    assert.deepEqual(state.sent, ["deleted"]);
  } finally {
    await app.stop();
  }
});

test("versioned receipts must advance the input version by one", async () => {
  async function run(stored: (value: Role) => Role) {
    const save = writer<(value: Role) => Promise<Upserted<Role>>>();
    const change = command({
      requirements: { save },
      run: async (_, ctx) => success(await ctx.save(role("r1", "admin", 3))),
    });
    const savePlug = plug({ port: save, bind: () => async (value) => upserted(stored(value)) });
    const app = await application([savePlug, change]);
    try {
      return await app.withScope((scope) => scope.resolve(change)());
    } finally {
      await app.stop();
    }
  }
  assert.ok(!(await run((value) => ({ ...value, version: 4 }))).isError);
  const unchanged = await run((value) => value);
  assert.ok(unchanged.isError && InternalFlowError.is(unchanged.error));
});

test("a versioned deletion receipt must keep the input version", async () => {
  async function run(removed: (value: Role) => Role) {
    const remove = writer<(value: Role) => Promise<Deleted<Role>>>();
    const change = command({
      requirements: { remove },
      run: async (_, ctx) => success(await ctx.remove(role("r1", "admin", 3))),
    });
    const removePlug = plug({ port: remove, bind: () => async (value) => deleted(removed(value)) });
    const app = await application([removePlug, change]);
    try {
      return await app.withScope((scope) => scope.resolve(change)());
    } finally {
      await app.stop();
    }
  }
  assert.ok(!(await run((value) => value)).isError);
  const advanced = await run((value) => ({ ...value, version: 4 }));
  assert.ok(advanced.isError && InternalFlowError.is(advanced.error));
});

test("VersionConflict keeps its identity and fails the command", async () => {
  const save = writer<(value: Role) => Promise<Upserted<Role>>>();
  const change = command({
    requirements: { save },
    run: async (_, ctx) => success(await ctx.save(role("r1", "admin", 3))),
  });
  const savePlug = plug({
    port: save,
    bind: () => async (value) => {
      throw VersionConflict("roles", value.id, value.version!);
    },
  });
  const app = await application([savePlug, change]);
  try {
    const result = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(result.isError && VersionConflict.is(result.error));
  } finally {
    await app.stop();
  }
});

test("outside a Unit of Work the receipt check runs without read layers", async () => {
  const save = writer<(value: Role) => Promise<Upserted<Role>>>();
  const savePlug = plug({
    port: save,
    bind: () => async (value) => upserted({ ...value, version: value.version! + 2 }),
  });
  const app = await application([savePlug]);
  try {
    await assert.rejects(
      () => app.withScope((scope) => scope.resolve(save)(role("r1", "admin", 3))),
      () => true,
    );
  } finally {
    await app.stop();
  }
});

test("a listener failure after a standalone write is a PostCommitError with phase changes", async () => {
  const save = writer<(value: Role) => Promise<Upserted<Role>>>();
  const savePlug = plug({
    port: save,
    bind: () => async (value) =>
      upserted(value.version === undefined ? value : { ...value, version: value.version + 1 }),
  });
  const app = await application([savePlug]);
  try {
    await assert.rejects(
      app.withScope(async (scope) => {
        const unsubscribe = scope.resolve(unitOfWorkChanges).subscribe({
          recorded() {},
          committed() {
            throw new Error("layer failed");
          },
          settled() {},
        });
        try {
          return await scope.resolve(save)(role("r1", "admin"));
        } finally {
          unsubscribe();
        }
      }),
      (error: unknown) => PostCommitError.is(error) && (error as { phase: string }).phase === "changes",
    );
  } finally {
    await app.stop();
  }
});

test("a deletion that cascades reports every receipt it returns as a committed change", async () => {
  interface Grant {
    readonly entity: "grant";
    readonly id: string;
    readonly roleId: string;
  }
  const grants: readonly Grant[] = [
    { entity: "grant", id: "g1", roleId: "r1" },
    { entity: "grant", id: "g2", roleId: "r1" },
  ];
  const deleteWithGrants = writer<(value: Role) => Promise<readonly (Deleted<Role> | Deleted<Grant>)[]>>();
  const remove = command({
    requirements: { deleteWithGrants },
    run: async (_, ctx) => success(await ctx.deleteWithGrants(role("r1", "admin"))),
  });
  const app = await application([
    plug({
      port: deleteWithGrants,
      bind: () => async (value) => [deleted(value), ...grants.map((grant) => deleted(grant))],
    }),
    remove,
  ]);
  try {
    const committed = await app.withScope(async (scope) => {
      const seen: { readonly entity: string; readonly id: unknown; readonly type: string }[] = [];
      scope.resolve(unitOfWorkChanges).subscribe({
        recorded() {},
        committed(changes) {
          seen.push(...changes.map(({ entity, id, type }) => ({ entity, id, type })));
        },
        settled() {},
      });
      assert.ok(!(await scope.resolve(remove)()).isError);
      return seen;
    });
    assert.deepEqual(committed, [
      { entity: "role", id: "r1", type: "delete" },
      { entity: "grant", id: "g1", type: "delete" },
      { entity: "grant", id: "g2", type: "delete" },
    ]);
  } finally {
    await app.stop();
  }
});

test("a failing recorded listener does not fail the write", async () => {
  const state = storage();
  const change = command({
    requirements: { saveRole },
    run: async (_, ctx) => success(await ctx.saveRole(role("r1", "admin"))),
  });
  const app = await application([...state.definitions, change]);
  try {
    await app.withScope(async (scope) => {
      scope.resolve(unitOfWorkChanges).subscribe({
        recorded() {
          throw new Error("record failed");
        },
        committed() {},
        settled() {},
      });
      const result = await scope.resolve(change)();
      assert.ok(result.isError && PostCommitError.is(result.error));
    });
  } finally {
    await app.stop();
  }
});

test("transaction() is one identity per Unit of Work", async () => {
  const inner = query({
    requirements: { changes: unitOfWorkChanges },
    run: async (_, ctx) => success(ctx.changes.transaction()),
  });
  const outer = command({
    requirements: { inner, changes: unitOfWorkChanges },
    run: async (_, ctx) => {
      const outerToken = ctx.changes.transaction();
      const innerResult = await ctx.inner();
      if (innerResult.isError) {
        return innerResult;
      }
      assert.equal(innerResult.value, outerToken);
      return success(undefined);
    },
  });
  const app = await application([inner, outer]);
  try {
    const result = await app.withScope((scope) => scope.resolve(outer)());
    assert.ok(!result.isError);
    const outside = app.withScope((scope) => scope.resolve(unitOfWorkChanges).transaction());
    assert.equal(await outside, undefined);
  } finally {
    await app.stop();
  }
});

test("overlapping writes keep number, string and bigint entity IDs distinct", async () => {
  type Item = { readonly entity: "item"; readonly id: string | number | bigint };
  const save = writer<(state: Item) => Promise<Upserted<Item>>>();
  const admitted = Promise.withResolvers<void>();
  let entered = 0;
  const states: Item[] = [
    { entity: "item", id: 1 },
    { entity: "item", id: "1" },
    { entity: "item", id: 1n },
  ];
  const storage = plug({
    port: save,
    bind: () => async (state) => {
      if (++entered === states.length) {
        admitted.resolve();
      }
      await admitted.promise;
      return upserted(state);
    },
  });
  const action = command({
    requirements: { save },
    run: async (_, ctx) => success(await Promise.all(states.map((state) => ctx.save(state)))),
  });
  const app = await application([storage, action]);
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    if (result.isError) {
      assert.fail(result.error.message);
    }
    assert.deepEqual(
      result.value.map((receipt) => receipt.next.id),
      [1, "1", 1n],
    );
  } finally {
    await app.stop();
  }
});
