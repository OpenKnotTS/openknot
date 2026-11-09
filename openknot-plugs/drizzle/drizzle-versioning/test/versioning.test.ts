import { drizzleVersioning } from "../src/index.ts";
import { createClient } from "@libsql/client";
import { VersionConflict, versioningOf } from "@openknot-ts/versioning";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import assert from "node:assert/strict";
import { test } from "node:test";

const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
});

async function database() {
  const client = createClient({ url: ":memory:" });
  await client.execute("CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL)");
  const db = drizzle({ client });
  return { client, rows: versioningOf(drizzleVersioning({ current: () => db })) };
}

test("save inserts at version 1 and updates only the expected version", async () => {
  const { client, rows } = await database();
  try {
    const inserted = await rows.save(roles, { id: "r1", name: "admin", version: 0 });
    assert.deepEqual(inserted, { id: "r1", name: "admin", version: 1 });
    const updated = await rows.save(roles, { ...inserted, name: "root" });
    assert.deepEqual(updated, { id: "r1", name: "root", version: 2 });
    await assert.rejects(rows.save(roles, { ...inserted, name: "stale" }), (error) => VersionConflict.is(error));
    await assert.rejects(rows.save(roles, { id: "r1", name: "again", version: 0 }), (error) =>
      VersionConflict.is(error),
    );
  } finally {
    client.close();
  }
});

test("remove deletes only the expected version and returns the deleted row", async () => {
  const { client, rows } = await database();
  try {
    const stored = await rows.save(roles, { id: "r1", name: "admin", version: 0 });
    await assert.rejects(rows.remove(roles, { ...stored, version: 7 }), (error) => VersionConflict.is(error));
    assert.deepEqual(await rows.remove(roles, stored), stored);
    await assert.rejects(rows.remove(roles, stored), (error) => VersionConflict.is(error));
  } finally {
    client.close();
  }
});

test("save and remove keep fields that are not columns", async () => {
  const { client, rows } = await database();
  try {
    const saved = await rows.save(roles, { entity: "role", id: "r1", name: "a", version: 0 });
    assert.equal(saved.entity, "role");
    assert.equal(saved.version, 1);
    const updated = await rows.save(roles, { ...saved, name: "b" });
    assert.equal(updated.entity, "role");
    assert.equal(updated.version, 2);
    const removed = await rows.remove(roles, updated);
    assert.equal(removed.entity, "role");
  } finally {
    client.close();
  }
});
