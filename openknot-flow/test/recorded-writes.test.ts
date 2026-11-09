import { command, upserted, writer } from "../src/index.ts";
import type { CommittedChange } from "../src/wire.ts";
import { unitOfWorkChanges } from "../src/wire.ts";
import { application } from "./fixtures/unit-of-work.ts";
import { success } from "@openknot-ts/behavior";
import { plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
}

const saveRole = writer<(value: Role) => Promise<ReturnType<typeof upserted<Role>>>>();
test("a write from an afterCommit effect reaches read-layer listeners once", async () => {
  const persisted = new Map<string, Role>();
  const deliveries: (readonly CommittedChange[])[] = [];
  const role: Role = { entity: "role", id: "r1", name: "admin" };
  const savePlug = plug({
    port: saveRole,
    bind: () => async (value) => {
      persisted.set(value.id, value);
      return upserted(value);
    },
  });
  const change = command({
    requirements: { saveRole },
    run: async (_, ctx) => {
      ctx.uow.afterCommit(async () => {
        await ctx.saveRole(role);
      });
      return success(undefined);
    },
  });
  const app = await application([savePlug, change]);
  try {
    await app.withScope(async (scope) => {
      const unsubscribe = scope.resolve(unitOfWorkChanges).subscribe({
        recorded() {},
        committed(changes) {
          deliveries.push(changes);
        },
        settled() {},
      });
      try {
        const result = await scope.resolve(change)();
        assert.ok(!result.isError);
      } finally {
        unsubscribe();
      }
    });
    assert.deepEqual([...persisted.values()], [role]);
    assert.equal(deliveries.length, 1, "one afterCommit write must deliver once");
    assert.deepEqual(deliveries, [[{ entity: "role", id: "r1", type: "set", state: role, writer: saveRole }]]);
  } finally {
    await app.stop();
  }
});
