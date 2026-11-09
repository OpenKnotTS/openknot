import { drizzleVersioning } from "../src/index.ts";
import { createClient } from "@libsql/client";
import { VersionConflict, versioningOf } from "@openknot-ts/versioning";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
});

const client = createClient({ url: ":memory:" });
await client.execute("CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL)");

const rows = versioningOf(drizzleVersioning({ current: () => drizzle({ client }) }));

const inserted = await rows.save(roles, { id: "r1", name: "admin", version: 0 });
const renamed = await rows.save(roles, { ...inserted, name: "root" });
console.log(`Saved ${renamed.name} at version ${renamed.version}.`);

// A write from a stale version is rejected.
try {
  await rows.save(roles, { ...inserted, name: "stale" });
} catch (error) {
  if (!VersionConflict.is(error)) {
    throw error;
  }

  console.log(`A write from version ${inserted.version} was rejected: ${error.type}.`);
}

client.close();
