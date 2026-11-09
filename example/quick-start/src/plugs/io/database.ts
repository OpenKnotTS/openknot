import { createClient } from "@libsql/client";
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import { healthCheck } from "@openknot-ts/health";
import { resource, unit } from "@openknot-ts/wire";
import { drizzle } from "drizzle-orm/libsql";

// A local in-memory SQLite database, created with its tables at startup.
export const database = resource({
  async initialize() {
    const client = createClient({ url: ":memory:" });

    try {
      await client.executeMultiple(`
        CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE logs (id TEXT PRIMARY KEY, action TEXT NOT NULL);
      `);

      return {
        value: drizzle({ client }),
        release() {
          client.close();
        },
      };
    } catch (error) {
      client.close();
      throw error;
    }
  },
});

export const transaction = unit({
  requirements: { database },
  factory: ({ database }) => drizzleUnitOfWork({ database }),
});

export const databaseHealth = healthCheck({
  name: "database",
  requirements: { database },
  check: async ({ database }) => {
    await database.$client.execute("SELECT 1");
    return "up";
  },
});
