import { drizzleUnitOfWork } from "../src/index.ts";
import type { UnitOfWorkImplementation } from "@openknot-ts/flow";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";

const rows = sqliteTable("rows", { id: integer("id").primaryKey() });
const database = drizzle.mock();
const uow = drizzleUnitOfWork({ database, transactionConfig: () => ({ behavior: "deferred" as const }) });
const implementation: UnitOfWorkImplementation = uow;
void implementation;
void uow.current().then((session) => session.insert(rows).values({ id: 1 }));
// @ts-expect-error Native transaction operations retain the schema's input types.
void uow.current().then((session) => session.insert(rows).values({ id: "wrong" }));
// @ts-expect-error Transaction configuration is inferred from the selected driver.
drizzleUnitOfWork({ database, transactionConfig: () => ({ behavior: "wrong" }) });
declare const syncDatabase: { transaction<T>(work: (session: object) => T): T };
// @ts-expect-error A synchronous driver cannot await asynchronous Flow work.
drizzleUnitOfWork({ database: syncDatabase });
