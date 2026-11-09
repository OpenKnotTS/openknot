import { drizzleOutboxOf } from "./store.ts";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export type { DrizzleOutboxOptions } from "./store.ts";

/** The outbox table; add it to the application's schema so its migrations create it. */
export const outboxTable = pgTable(
  "openknot_outbox",
  {
    sequence: bigint("sequence", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: text("id").notNull().unique(),
    name: text("name").notNull(),
    message: text("message").notNull(),
    propagation: text("propagation"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    claimedBy: text("claimed_by"),
    claimedUntil: bigint("claimed_until", { mode: "number" }),
  },
  (table) => [index("openknot_outbox_name_sequence").on(table.name, table.sequence)],
);

interface PostgresDatabase {
  execute(query: SQL, mode: "objects"): PromiseLike<readonly Readonly<Record<string, unknown>>[]>;
}

/** The outbox store over PostgreSQL, saving records in the Drizzle Unit of Work's transaction. */
export const drizzleOutbox = drizzleOutboxOf<PostgresDatabase>({
  now: sql`(extract(epoch from clock_timestamp()) * 1000)::bigint`,
  rows: async (database, query) => database.execute(query, "objects"),
});
