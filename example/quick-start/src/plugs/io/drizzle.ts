import { listRoles, listLogs } from "../../app/behavior/readers.ts";
import { saveRoleWriter, saveLogWriter, userHasAccessToRole } from "../../app/flow/ports.ts";
import { transaction } from "./database.ts";
import { reader } from "@openknot-ts/behavior";
import { defaultUnitOfWork, upserted, writer } from "@openknot-ts/flow";
import { actorResolver } from "@openknot-ts/flow/wire";
import { config, plug } from "@openknot-ts/wire";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

// Access: the example token and actor are defaults; set ACCESS_TOKEN and ACCESS_ACTOR to change them.
export const accessConfig = config({
  ACCESS_TOKEN: z.string().min(1).default("example-token"),
  ACCESS_ACTOR: z.string().min(1).default("example-user"),
});

export const identity = actorResolver({
  requirements: { accessConfig },
  resolve: (token: string, { accessConfig }) =>
    token === accessConfig.ACCESS_TOKEN ? { userId: accessConfig.ACCESS_ACTOR } : undefined,
});

// Tables
export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull(),
});

export const logs = sqliteTable("logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
});

// Unit of Work, readers and writers over the same Drizzle transaction
export const storage = {
  unitOfWork: plug({
    port: defaultUnitOfWork,
    requirements: { transaction },
    bind: ({ transaction }) => transaction,
  }),

  readers: plug({
    port: reader.compose({ listRoles, listLogs, userHasAccessToRole }),
    requirements: { transaction, accessConfig },
    bind: ({ transaction, accessConfig }) => ({
      listRoles: async () => (await transaction.current()).select().from(roles),
      listLogs: async () => (await transaction.current()).select().from(logs),
      userHasAccessToRole: async (userId) => userId !== undefined && userId === accessConfig.ACCESS_ACTOR,
    }),
  }),

  writers: plug({
    port: writer.compose({ saveRoleWriter, saveLogWriter }),
    requirements: { transaction },
    bind: ({ transaction }) => ({
      saveRoleWriter: async (role) => {
        const session = await transaction.current();
        const [saved] = await session
          .insert(roles)
          .values(role)
          .onConflictDoUpdate({ target: roles.id, set: role })
          .returning();

        return upserted(saved!);
      },

      saveLogWriter: async (log) => {
        const session = await transaction.current();
        const [saved] = await session
          .insert(logs)
          .values(log)
          .onConflictDoUpdate({ target: logs.id, set: log })
          .returning();

        return upserted(saved!);
      },
    }),
  }),
};
