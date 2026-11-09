import { drizzleOutbox } from "../src/sqlite.ts";
import { createClient } from "@libsql/client";
import { success } from "@openknot-ts/behavior";
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import { command, defaultUnitOfWork, publisher, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { outbox } from "@openknot-ts/outbox";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RoleCreated {
  readonly type: "role-created";
  readonly name: string;
}

// A file database with the application's table and the outbox table
const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

const directory = await mkdtemp(join(tmpdir(), "openknot-outbox-example-"));
const client = createClient({ url: `file:${join(directory, "app.db")}` });

await client.executeMultiple(`
  CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE openknot_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    message TEXT NOT NULL, propagation TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, claimed_by TEXT, claimed_until INTEGER);
`);

const database = drizzle({ client });

// The command saves a role and publishes an event in the same transaction.
const roleEvents = publisher<RoleCreated>();
const saveRole = writer<(role: { readonly id: string; readonly name: string }) => Promise<void>>();

const createRole = command<{ readonly id: string; readonly name: string }>()({
  requirements: { saveRole, roleEvents },
  run: async (role, ctx) => {
    await ctx.saveRole(role);
    await ctx.roleEvents.publish({ type: "role-created", name: role.name });
    return success();
  },
});

// The native "broker" the outbox delivers to after the commit
const bus = new EventEmitter<{ roleCreated: [RoleCreated, string | undefined] }>();
bus.on("roleCreated", (event, messageId) => console.log(`delivered ${event.name} as ${messageId}`));

const transaction = unit({ factory: () => drizzleUnitOfWork({ database }) });

const roleEventsBus = plug({
  port: roleEvents,
  bind: () => (event, options) => void bus.emit("roleCreated", event, options.messageId),
});

const application = defineApplication({
  modules: [
    composeModule({
      providers: [
        createRole,
        transaction,
        plug({ port: defaultUnitOfWork, requirements: { transaction }, bind: ({ transaction }) => transaction }),
        plug({
          port: saveRole,
          requirements: { transaction },
          bind:
            ({ transaction }) =>
            async (role) => {
              await (await transaction.current()).insert(roles).values(role);
            },
        }),

        // The outbox takes the native publisher's place; the store keeps records in the same transaction.
        outbox({ name: "role-events", plug: roleEventsBus }),
        drizzleOutbox({ transaction }),
      ].map((source) => ({ source })),
    }),
  ],
});

const app = await runApplication(application);

const delivered = once(bus, "roleCreated");
await app.withScope((scope) => scope.resolve(createRole)({ id: "r1", name: "admin" }));
await delivered;

await app.stop();

const remaining = await client.execute("SELECT count(*) AS count FROM openknot_outbox");
console.log("undelivered:", remaining.rows[0]!.count);

client.close();
await rm(directory, { recursive: true, force: true });
