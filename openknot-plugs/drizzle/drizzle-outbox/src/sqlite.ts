import { drizzleOutboxOf } from "./store.ts";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type { DrizzleOutboxOptions } from "./store.ts";

/** The outbox table; add it to the application's schema so its migrations create it. */
export const outboxTable = sqliteTable(
  "openknot_outbox",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    name: text("name").notNull(),
    message: text("message").notNull(),
    propagation: text("propagation"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    claimedBy: text("claimed_by"),
    claimedUntil: integer("claimed_until"),
  },
  (table) => [index("openknot_outbox_name_sequence").on(table.name, table.sequence)],
);

interface SQLiteDatabase {
  all(query: SQL): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

/** The outbox store over SQLite, saving records in the Drizzle Unit of Work's transaction. */
export const drizzleOutbox = drizzleOutboxOf<SQLiteDatabase>({
  now: sql`cast(unixepoch('subsec') * 1000 as integer)`,
  rows: (database, query) => database.all(query),
});
