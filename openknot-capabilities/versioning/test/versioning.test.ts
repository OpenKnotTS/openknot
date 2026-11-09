import type { VersionedRow, VersioningImplementation } from "../src/index.ts";
import { VersionConflict, versioningOf } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role extends VersionedRow {
  readonly entity: "role";
  readonly name: string;
}

/** A store of one table that answers like a native versioned write: the changed row, or undefined. */
function memory(): VersioningImplementation<"roles"> & { readonly rows: Map<VersionedRow["id"], VersionedRow> } {
  const rows = new Map<VersionedRow["id"], VersionedRow>();
  return {
    rows,
    async insert(_target, row) {
      if (rows.has(row.id)) {
        return undefined;
      }
      const stored = { id: row.id, version: 1, name: (row as Role).name };
      rows.set(row.id, stored);
      return stored;
    },
    async update(_target, row, expectedVersion) {
      const current = rows.get(row.id);
      if (current?.version !== expectedVersion) {
        return undefined;
      }
      const stored = { id: row.id, version: expectedVersion + 1, name: (row as Role).name };
      rows.set(row.id, stored);
      return stored;
    },
    async remove(_target, id, expectedVersion) {
      const current = rows.get(id);
      if (current?.version !== expectedVersion) {
        return undefined;
      }
      rows.delete(id);
      return current;
    },
    name: (target) => target,
  };
}

test("save inserts at version 0, updates by the stored version and keeps input-only fields", async () => {
  const versioning = versioningOf(memory());
  const created = await versioning.save("roles", { entity: "role", id: "r1", version: 0, name: "admin" } as Role);
  assert.deepEqual(created, { entity: "role", id: "r1", version: 1, name: "admin" });
  const renamed = await versioning.save("roles", { ...created, name: "owner" });
  assert.deepEqual(renamed, { entity: "role", id: "r1", version: 2, name: "owner" });
});

test("a stale version is a VersionConflict naming the target, for saves and removals", async () => {
  const store = memory();
  const versioning = versioningOf(store);
  await versioning.save("roles", { entity: "role", id: "r1", version: 0, name: "admin" } as Role);
  const stale = { entity: "role", id: "r1", version: 0, name: "again" } as Role;
  for (const attempt of [
    () => versioning.save("roles", stale),
    () => versioning.save("roles", { ...stale, version: 5 }),
    () => versioning.remove("roles", { ...stale, version: 5 }),
  ]) {
    await assert.rejects(attempt(), (error: unknown) => {
      assert.ok(VersionConflict.is(error));
      assert.deepEqual([error.target, error.id], ["roles", "r1"]);
      return true;
    });
  }
  const removed = await versioning.remove("roles", { ...stale, version: 1 });
  assert.deepEqual(removed, { entity: "role", id: "r1", version: 1, name: "admin" });
  assert.equal(store.rows.size, 0);
});

test("a version that is not a non-negative integer is rejected before the store is called", async () => {
  const versioning = versioningOf(memory());
  for (const version of [-1, 1.5, Number.NaN]) {
    await assert.rejects(
      versioning.save("roles", { entity: "role", id: "r1", version, name: "admin" } as Role),
      /non-negative integer version/,
    );
  }
});
