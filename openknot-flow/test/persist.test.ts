import { persist, upserted } from "../src/index.ts";
import { created, deleted, unchanged, updated } from "@openknot-ts/behavior";
import type { OperationOutput } from "@openknot-ts/behavior";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role {
  readonly id: string;
  readonly version: number;
}

test("persist() applies each operation output through its writer and returns the persisted state", async () => {
  const calls: string[] = [];
  const writers = {
    upsert: async (role: Role) => {
      calls.push(`upsert ${role.id}`);
      return upserted({ ...role, version: role.version + 1 });
    },
    delete: async (role: Role) => {
      calls.push(`delete ${role.id}`);
      return deleted(role);
    },
  };
  const role: Role = { id: "r1", version: 1 };

  assert.deepEqual(await persist(created(role), writers), { id: "r1", version: 2 });
  assert.deepEqual(await persist(updated(role), writers), { id: "r1", version: 2 });
  assert.equal(await persist(deleted(role), writers), undefined);
  assert.equal(await persist(unchanged(role), writers), role);
  assert.deepEqual(calls, ["upsert r1", "upsert r1", "delete r1"]);
});

test("persist() writes a list through one upsert and one delete call and returns the kept states in order", async () => {
  const calls: string[] = [];
  const writers = {
    upsert: async (roles: readonly Role[]) => {
      calls.push(`upsert ${roles.map((role) => role.id).join(",")}`);
      return roles.map((role) => upserted({ ...role, version: role.version + 1 }));
    },
    delete: async (roles: readonly Role[]) => {
      calls.push(`delete ${roles.map((role) => role.id).join(",")}`);
      return roles.map((role) => deleted(role));
    },
  };
  const role = (id: string): Role => ({ id, version: 1 });
  const kept = role("r4");

  const persisted = await persist(
    [deleted(role("r1")), created(role("r2")), unchanged(kept), updated(role("r3"))],
    writers,
  );

  assert.deepEqual(persisted, [{ id: "r2", version: 2 }, kept, { id: "r3", version: 2 }]);
  assert.equal(persisted[1], kept);
  assert.deepEqual(calls, ["upsert r2,r3", "delete r1"]);
  assert.deepEqual(await persist([unchanged(kept)], writers), [kept]);
  const nothing: readonly OperationOutput<Role>[] = [];
  assert.deepEqual(await persist(nothing, writers), []);
  assert.deepEqual(calls, ["upsert r2,r3", "delete r1"], "A list without upserts or deletions calls no writer.");
});

test("persist() refuses an upsert writer that returns a receipt count other than its state count", async () => {
  await assert.rejects(
    persist([created({ id: "r1", version: 1 }), created({ id: "r2", version: 1 })], {
      upsert: async (roles: readonly Role[]) => [upserted(roles[0]!)],
    }),
    TypeError,
  );
});

test("persist() propagates a writer's failure", async () => {
  const failure = new Error("write failed");
  await assert.rejects(
    persist(created({ id: "r1", version: 1 }), {
      upsert: async () => {
        throw failure;
      },
    }),
    failure,
  );
});
