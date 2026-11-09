import "@openknot-ts/flow/wire";
import { database, databaseHealth, transaction } from "./database.ts";
import { storage, identity } from "./drizzle.ts";
import { providePlugs } from "@openknot-ts/wire";

export { accessConfig, identity, roles, logs, storage } from "./drizzle.ts";
export { database, databaseHealth, transaction } from "./database.ts";

export const io = providePlugs([database, transaction, databaseHealth, identity, storage]);
