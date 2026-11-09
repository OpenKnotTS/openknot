import type { UnitOfWorkImplementation, UnitOfWorkOptions } from "@openknot-ts/flow";
import type { MySqlAsyncDatabase, MySqlQueryResultHKT } from "drizzle-orm/mysql-core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core";
import { AsyncLocalStorage } from "node:async_hooks";

// A native transaction may open a pooled connection that outlives the work: it opens in the context this module loaded
// in, so that connection keeps no execution alive, wherever a Unit of Work is created.
const outside = AsyncLocalStorage.snapshot();

type NativeDatabase =
  | Pick<SQLiteAsyncDatabase<"async", unknown>, "transaction">
  | Pick<PgAsyncDatabase<PgQueryResultHKT>, "transaction">
  | Pick<MySqlAsyncDatabase<MySqlQueryResultHKT>, "transaction">;

/** Keeps the callback/config correlation across Drizzle's different native transaction signatures. */
export type DrizzleDatabase<Session, Config = unknown> = NativeDatabase & {
  transaction<T>(work: (session: Session) => Promise<T>, config?: Config): Promise<T>;
};

export interface DrizzleUnitOfWork<Session, Database> extends UnitOfWorkImplementation {
  /** The native transaction once the current Unit of Work has opened it; undefined before and outside it. */
  readonly session: Session | undefined;
  /**
   * The current Unit of Work's transaction, opened by the first call, or the provided database outside one; await it
   * on every IO call.
   */
  current(): Promise<Session | Database>;
}

export interface DrizzleUnitOfWorkOptions<Session, Config> {
  readonly database: DrizzleDatabase<Session, Config>;
  readonly transactionConfig?: (options: UnitOfWorkOptions) => NoInfer<Config>;
}

interface Work<Session> {
  readonly execution: UnitOfWorkOptions;
  session: Session | undefined;
  opened: Promise<Session> | undefined;
  /** Settles once the Unit of Work's work has ended, which ends the native callback. */
  readonly ended: PromiseWithResolvers<void>;
  native: Promise<void> | undefined;
  /** After the work, IO uses the provided database, so effects and publications never open a transaction. */
  closed: boolean;
}

/** The driver owns commit/rollback; Flow owns hooks, effects and publications. */
export function drizzleUnitOfWork<Session, Config, Database extends DrizzleDatabase<Session, Config>>(
  options: DrizzleUnitOfWorkOptions<Session, Config> & {
    readonly database: Database;
  },
): DrizzleUnitOfWork<Session, Database> {
  const { database, transactionConfig } = options;
  const works = new AsyncLocalStorage<Work<Session>>();

  function open(work: Work<Session>): Promise<Session> {
    const opened = Promise.withResolvers<Session>();
    work.execution.signal.throwIfAborted();
    const config = transactionConfig?.(work.execution);
    work.native = outside(() =>
      database.transaction(async (session) => {
        work.execution.signal.throwIfAborted();
        work.session = session;
        opened.resolve(session);
        await work.ended.promise;
      }, config),
    );
    // A transaction that fails to open fails the access that opened it; its outcome is awaited when the work ends.
    work.native.catch(opened.reject);
    return opened.promise;
  }

  return Object.freeze({
    get session() {
      const work = works.getStore();
      return work === undefined || work.closed ? undefined : work.session;
    },
    async current() {
      const work = works.getStore();

      if (work === undefined || work.closed) {
        return database;
      }

      work.opened ??= open(work);
      return work.opened;
    },
    async transaction<T>(run: () => Promise<T>, execution: UnitOfWorkOptions): Promise<T> {
      execution.signal.throwIfAborted();
      const work: Work<Session> = {
        execution,
        session: undefined,
        opened: undefined,
        ended: Promise.withResolvers<void>(),
        native: undefined,
        closed: false,
      };
      // Only a callback that runs awaits the end; a transaction that never opened leaves a failed end unobserved.
      work.ended.promise.catch(() => undefined);
      let value: T;

      try {
        value = await works.run(work, run);
      } catch (error) {
        work.closed = true;

        if (work.native !== undefined) {
          work.ended.reject(error);
          // Once the callback ran, Drizzle reports the rollback; a transaction that never opened has nothing to undo.
          const nativeFailure = await work.native.then(
            () => undefined,
            (cause: unknown) => ({ cause }),
          );

          if (nativeFailure !== undefined && work.session !== undefined) {
            throw nativeFailure.cause;
          }
        }

        throw error;
      }

      work.closed = true;

      if (work.native !== undefined) {
        work.ended.resolve();
        await work.native;
      }

      return value;
    },
  });
}
