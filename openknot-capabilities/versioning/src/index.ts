import { error } from "@openknot-ts/behavior";

export type VersionKey = string | number | bigint;

export interface VersionedRow {
  readonly id: VersionKey;
  readonly version: number;
}

export const VersionConflict = error("VersionConflict", (target: string, id: VersionKey, expectedVersion: number) => ({
  message: `Version conflict on ${target} ${String(id)}: expected version ${expectedVersion}`,
  target,
  id,
  expectedVersion,
}));

export interface VersionConflict extends ReturnType<typeof VersionConflict> {}

/** Native operations only; each returns undefined when no row changed. */
export interface VersioningImplementation<Target> {
  insert(target: Target, row: VersionedRow): Promise<VersionedRow | undefined>;
  update(target: Target, row: VersionedRow, expectedVersion: number): Promise<VersionedRow | undefined>;
  remove(target: Target, id: VersionKey, expectedVersion: number): Promise<VersionedRow | undefined>;
  name?(target: Target): string;
}

export interface Versioning<Target> {
  /**
   * Inserts when `version` is 0, otherwise updates where the stored version matches.
   * Returns the input row merged with the stored row: input-only fields are retained,
   * and database-returned columns take precedence.
   */
  save<Row extends VersionedRow>(target: Target, row: Row): Promise<Row>;
  /**
   * Deletes where the stored version matches.
   * Returns the input row merged with the deleted row: input-only fields are retained,
   * and database-returned columns take precedence.
   */
  remove<Row extends VersionedRow>(target: Target, row: Row): Promise<Row>;
}

function requireVersion(row: VersionedRow): void {
  if (!Number.isSafeInteger(row.version) || row.version < 0) {
    throw new TypeError("A versioned row requires a non-negative integer version");
  }
}

export function versioningOf<Target>(implementation: VersioningImplementation<Target>): Versioning<Target> {
  const name = (target: Target) => implementation.name?.(target) ?? "row";
  return Object.freeze({
    async save<Row extends VersionedRow>(target: Target, row: Row): Promise<Row> {
      requireVersion(row);
      const stored =
        row.version === 0
          ? await implementation.insert(target, row)
          : await implementation.update(target, row, row.version);

      if (stored === undefined) {
        throw VersionConflict(name(target), row.id, row.version);
      }

      // Preserve fields that are not columns (e.g. `entity`) from the input, while DB-returned values (e.g. version) take precedence.
      return { ...row, ...stored } as Row;
    },
    async remove<Row extends VersionedRow>(target: Target, row: Row): Promise<Row> {
      requireVersion(row);
      const removed = await implementation.remove(target, row.id, row.version);

      if (removed === undefined) {
        throw VersionConflict(name(target), row.id, row.version);
      }

      // Preserve fields that are not columns (e.g. `entity`) from the input, while DB-returned values take precedence.
      return { ...row, ...removed } as Row;
    },
  });
}
