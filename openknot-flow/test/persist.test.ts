import { persist, upserted } from "../src/index.ts";
import { created, deleted, unchanged, updated } from "@openknot-ts/behavior";
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
