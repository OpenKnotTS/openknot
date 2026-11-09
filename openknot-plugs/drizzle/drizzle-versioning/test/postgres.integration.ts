import { drizzleVersioning } from "../src/index.ts";
import { VersionConflict, versioningOf } from "@openknot-ts/versioning";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "";
const skip = url === "" ? "set DATABASE_URL to run against Postgres" : false;

const conflict = (expectedVersion: number) => (error: unknown) =>
  VersionConflict.is(error) && error.expectedVersion === expectedVersion;

test("versioned saves and removals on Postgres refuse stale versions, also when they race", { skip }, async () => {
  const name = `versioned_roles_${randomUUID().slice(0, 8)}`;
  const pool = new pg.Pool({ connectionString: url });
  await pool.query(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL)`);
  const roles = pgTable(name, { id: text().primaryKey(), name: text().notNull(), version: integer().notNull() });
  const versioning = versioningOf(drizzleVersioning({ current: () => drizzle({ client: pool }) }));
  const save = (role: string, version: number) => versioning.save(roles, { id: "r1", name: role, version });
  try {
    assert.deepEqual(await save("Dispatcher", 0), { id: "r1", name: "Dispatcher", version: 1 });
    await assert.rejects(save("Other", 0), conflict(0));
    assert.equal((await save("Manager", 1)).version, 2);
    await assert.rejects(save("Stale", 1), conflict(1));

    const raced = await Promise.allSettled([save("First", 2), save("Second", 2)]);
    assert.deepEqual(raced.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.ok(raced.some((result) => result.status === "rejected" && conflict(2)(result.reason)));

    await assert.rejects(versioning.remove(roles, { id: "r1", name: "Any", version: 2 }), conflict(2));
    assert.equal((await versioning.remove(roles, { id: "r1", name: "Any", version: 3 })).version, 3);
    assert.deepEqual((await pool.query(`SELECT * FROM ${name}`)).rows, []);
  } finally {
    await pool.query(`DROP TABLE ${name}`);
    await pool.end();
  }
});
