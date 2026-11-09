import type { VersionedRow, VersioningImplementation } from "@openknot-ts/versioning";
import { and, eq, is, sql } from "drizzle-orm";
import { PgAsyncDatabase, PgTable } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { SQLiteAsyncDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/** A Drizzle table with `id` and `version` columns. */
export type VersionedTable =
  | (SQLiteTable & { readonly id: AnySQLiteColumn; readonly version: AnySQLiteColumn })
  | (PgTable & { readonly id: AnyPgColumn; readonly version: AnyPgColumn });

export type VersioningSession = SQLiteAsyncDatabase<"async", unknown> | PgAsyncDatabase<PgQueryResultHKT>;

export function drizzleVersioning(transaction: {
  readonly current: () => VersioningSession | PromiseLike<VersioningSession>;
}): VersioningImplementation<VersionedTable> {
  function first(rows: unknown): VersionedRow | undefined {
    if (!Array.isArray(rows)) {
      throw new TypeError("Drizzle returning() must return rows");
    }

    const row: unknown = rows[0];
    if (row === undefined) {
      return undefined;
    }

    if (typeof row !== "object" || row === null || !("id" in row) || !("version" in row)) {
      throw new TypeError("A versioned Drizzle row requires id and version columns");
    }

    const { id, version } = row;

    if ((typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") || typeof version !== "number") {
      throw new TypeError("A versioned Drizzle row requires a scalar id and numeric version");
    }

    return { ...row, id, version };
  }
  return Object.freeze({
    async insert(table: VersionedTable, row: VersionedRow) {
      const session = await transaction.current();

      if (is(session, SQLiteAsyncDatabase) && is(table, SQLiteTable)) {
        return first(
          await session
            .insert(table)
            .values({ ...row, version: 1 })
            .onConflictDoNothing()
            .returning(),
        );
      }

      if (is(session, PgAsyncDatabase) && is(table, PgTable)) {
        return first(
          await session
            .insert(table)
            .values({ ...row, version: 1 })
            .onConflictDoNothing()
            .returning(),
        );
      }

      throw new TypeError("The Drizzle session and table must use the same supported dialect");
    },
    async update(table: VersionedTable, row: VersionedRow, expectedVersion: number) {
      const session = await transaction.current();
      const changes = { ...row, version: sql`${table.version} + 1` };
      const matches = and(eq(table.id, row.id), eq(table.version, expectedVersion));

      if (is(session, SQLiteAsyncDatabase) && is(table, SQLiteTable)) {
        return first(await session.update(table).set(changes).where(matches).returning());
      }

      if (is(session, PgAsyncDatabase) && is(table, PgTable)) {
        return first(await session.update(table).set(changes).where(matches).returning());
      }

      throw new TypeError("The Drizzle session and table must use the same supported dialect");
    },
    async remove(table: VersionedTable, id: VersionedRow["id"], expectedVersion: number) {
      const session = await transaction.current();
      const matches = and(eq(table.id, id), eq(table.version, expectedVersion));

      if (is(session, SQLiteAsyncDatabase) && is(table, SQLiteTable)) {
        return first(await session.delete(table).where(matches).returning());
      }

      if (is(session, PgAsyncDatabase) && is(table, PgTable)) {
        return first(await session.delete(table).where(matches).returning());
      }

      throw new TypeError("The Drizzle session and table must use the same supported dialect");
    },
  });
}
