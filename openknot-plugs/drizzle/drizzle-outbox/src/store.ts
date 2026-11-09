import type { OutboxStore, StuckRecord } from "@openknot-ts/outbox";
import { outboxStore } from "@openknot-ts/outbox";
import type { Requirement, Requirements, RequirementsOptions, ResolvedReferences } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

type Row = Readonly<Record<string, unknown>>;

export interface Transaction<D> {
  readonly session: unknown;
  current(): Promise<D>;
}

/** What differs between databases: how a statement returns its rows and the database clock in milliseconds. */
export interface Dialect<D> {
  readonly now: SQL;
  rows(database: D, query: SQL): Promise<readonly Row[]>;
}

type ResolvesTransaction<T extends Requirement, D> =
  ResolvedReferences<{ readonly transaction: T }>["transaction"] extends Transaction<D> ? T : never;

export type DrizzleOutboxOptions<T extends Requirement, D, R extends Requirements = {}> = RequirementsOptions<R> & {
  /** The application's `drizzleUnitOfWork()`, whose transaction the records join. */
  readonly transaction: ResolvesTransaction<T, D>;
  /** How long a claim lasts before another instance may take the records over. Defaults to 30 seconds. */
  readonly leaseMs?: number | ((dependencies: ResolvedReferences<R>) => number);
};

const table = sql.identifier("openknot_outbox");

function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function outboxOf<D>(transaction: Transaction<D>, dialect: Dialect<D>, leaseMs: number): OutboxStore {
  const { now } = dialect;
  const run = async (query: SQL) => dialect.rows(await transaction.current(), query);

  const store: OutboxStore = {
    async save(records) {
      const session = await transaction.current();
      if (transaction.session === undefined) {
        throw new TypeError("Outbox records must be saved in the Drizzle Unit of Work's transaction.");
      }
      if (records.length === 0) {
        return;
      }
      const values = records.map(
        (record) =>
          sql`(${record.id}, ${record.name}, ${JSON.stringify(record.message)}, ${
            record.propagation === undefined ? null : JSON.stringify(record.propagation)
          })`,
      );
      await dialect.rows(
        session,
        sql`insert into ${table} (id, name, message, propagation) values ${sql.join(values, sql`, `)}`,
      );
    },
    async claim(name, owner, limit) {
      const rows = await run(sql`
        update ${table} set claimed_by = ${owner}, claimed_until = ${now} + ${leaseMs}
        where sequence in (
          select sequence from ${table}
          where name = ${name} and (claimed_until is null or claimed_until < ${now} or claimed_by = ${owner})
          order by sequence limit ${limit}
        )
        and not exists (
          select 1 from ${table} other
          where other.name = ${name} and other.claimed_by <> ${owner} and other.claimed_until >= ${now}
        )
        returning sequence, id, name, message, propagation`);
      return rows
        .map((row) => ({ row, sequence: Number(row.sequence) }))
        .sort((a, b) => a.sequence - b.sequence)
        .map(({ row }) => ({
          id: String(row.id),
          name: String(row.name),
          message: JSON.parse(String(row.message)) as unknown,
          ...(row.propagation === null ? {} : { propagation: JSON.parse(String(row.propagation)) as never }),
        }));
    },
    async renew(ids, owner) {
      if (ids.length === 0) {
        return true;
      }
      const renewed = await run(sql`
        update ${table} set claimed_until = ${now} + ${leaseMs}
        where id in (${list(ids)}) and claimed_by = ${owner}
        returning id`);
      return renewed.length === ids.length;
    },
    async heldFor(name, owner) {
      const [row] = await run(sql`
        select max(claimed_until) - ${now} as held from ${table}
        where name = ${name} and claimed_by <> ${owner} and claimed_until >= ${now}`);
      return row?.held === null || row?.held === undefined ? undefined : Number(row.held);
    },
    async complete(ids) {
      if (ids.length > 0) {
        await run(sql`delete from ${table} where id in (${list(ids)})`);
      }
    },
    async attempted(id, owner, error) {
      await run(sql`
        update ${table} set attempts = attempts + 1, error = ${error}, claimed_by = null, claimed_until = null
        where id = ${id} and claimed_by = ${owner}`);
    },
    async release(ids, owner) {
      if (ids.length > 0) {
        await run(sql`
          update ${table} set claimed_by = null, claimed_until = null
          where id in (${list(ids)}) and claimed_by = ${owner}`);
      }
    },
    async stuck(attempts, name): Promise<readonly StuckRecord[]> {
      const rows = await run(sql`
        select id, name, attempts, error from ${table}
        where attempts >= ${attempts}${name === undefined ? sql`` : sql` and name = ${name}`}
        order by sequence`);
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        attempts: Number(row.attempts),
        error: row.error === null ? undefined : String(row.error),
      }));
    },
    async discard(id) {
      await run(sql`delete from ${table} where id = ${id}`);
    },
  };
  return Object.freeze(store);
}

export function drizzleOutboxOf<D>(dialect: Dialect<D>) {
  return function drizzleOutbox<const T extends Requirement, const R extends Requirements = {}>(
    options: DrizzleOutboxOptions<T, D, R>,
  ) {
    const { transaction, leaseMs = 30_000 } = options;
    return unit({
      provides: outboxStore,
      requirements: { ...options.requirements, transaction: transaction as T } as R & { readonly transaction: T },
      factory: (dependencies) => {
        const duration = typeof leaseMs === "function" ? leaseMs(dependencies) : leaseMs;
        if (!Number.isSafeInteger(duration) || duration < 1) {
          throw new TypeError("drizzleOutbox() leaseMs must be a positive integer.");
        }
        return outboxOf(
          (dependencies as unknown as { readonly transaction: Transaction<D> }).transaction,
          dialect,
          duration,
        );
      },
    });
  };
}
