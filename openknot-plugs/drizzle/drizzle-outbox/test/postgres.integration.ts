import { drizzleOutbox } from "../src/pg.ts";
import { success } from "@openknot-ts/behavior";
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import type { PublishOptions } from "@openknot-ts/flow";
import { command, defaultUnitOfWork, publisher, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { outbox, outboxStore } from "@openknot-ts/outbox";
import { postgresClient } from "@openknot-ts/postgres-client";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "";
const skip = url === "" ? "set DATABASE_URL to run against Postgres" : false;
const roles = pgTable("outbox_roles", { id: text("id").primaryKey(), name: text("name").notNull() });

async function prepare(): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      DROP TABLE IF EXISTS openknot_outbox, outbox_roles;
      CREATE TABLE outbox_roles (id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE openknot_outbox (sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id text NOT NULL UNIQUE,
        name text NOT NULL, message text NOT NULL, propagation text, attempts integer NOT NULL DEFAULT 0, error text,
        claimed_by text, claimed_until bigint);`);
  } finally {
    await client.end();
  }
}

function application() {
  const sent: unknown[] = [];
  const delivered = Promise.withResolvers<void>();
  const postgres = postgresClient({
    create: () => new pg.Pool({ connectionString: url }).on("error", () => undefined),
  });
  const transaction = unit({
    requirements: { postgres },
    factory: ({ postgres }) => drizzleUnitOfWork({ database: drizzle({ client: postgres }) }),
  });
  const events = publisher<{ readonly name: string }>();
  const saveRole = writer<(role: { readonly id: string; readonly name: string }) => Promise<void>>();
  const change = command<{ readonly id: string; readonly name: string }>()({
    requirements: { saveRole, events },
    run: async (role, ctx) => {
      await ctx.saveRole(role);
      await ctx.events.publish({ name: role.name });
      return success();
    },
  });
  const native = plug({
    port: events,
    bind: () => (message: { readonly name: string }, _options: PublishOptions) =>
      void (sent.push(message), delivered.resolve()),
  });
  const definitions = [
    change,
    transaction,
    plug({ port: defaultUnitOfWork, requirements: { transaction }, bind: ({ transaction }) => transaction }),
    plug({
      port: saveRole,
      requirements: { transaction },
      bind:
        ({ transaction }) =>
        async (role: { readonly id: string; readonly name: string }) => {
          await (await transaction.current()).insert(roles).values(role);
        },
    }),
    outbox({ name: "roles", plug: native }),
    drizzleOutbox({ transaction }),
  ];
  return {
    sent,
    delivered: delivered.promise,
    change,
    start: () =>
      runApplication(
        defineApplication({ modules: [composeModule({ providers: definitions.map((source) => ({ source })) })] }),
        { stopOn: [] },
      ),
  };
}

test("on PostgreSQL a change and its publication commit together and are delivered", { skip }, async () => {
  await prepare();
  const { start, change, sent, delivered } = application();
  const app = await start();
  try {
    assert.ok(!(await app.withScope((scope) => scope.resolve(change)({ id: "r1", name: "admin" }))).isError);
    await delivered;
  } finally {
    await app.stop();
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    assert.deepEqual((await client.query("SELECT id, name FROM outbox_roles")).rows, [{ id: "r1", name: "admin" }]);
    assert.deepEqual((await client.query("SELECT * FROM openknot_outbox")).rows, []);
  } finally {
    await client.end();
  }
  assert.deepEqual(sent, [{ name: "admin" }]);
});

test("on PostgreSQL concurrent claims never hand one name to two owners", { skip }, async () => {
  await prepare();
  const { start } = application();
  const app = await start();
  try {
    const store = app.resolve(outboxStore);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      for (const id of ["a", "b", "c"]) {
        await client.query("INSERT INTO openknot_outbox (id, name, message) VALUES ($1, 'direct', $2)", [
          id,
          JSON.stringify({ id }),
        ]);
      }
      const claims = await Promise.all(
        ["one", "two", "three", "four"].map((owner) => store.claim("direct", owner, 10)),
      );
      const winners = claims.filter((records) => records.length > 0);
      assert.equal(winners.length, 1);
      assert.deepEqual(
        winners[0]!.map((record) => record.id),
        ["a", "b", "c"],
      );

      await client.query("UPDATE openknot_outbox SET claimed_until = 0");
      assert.deepEqual(
        (await store.claim("direct", "five", 2)).map((record) => record.id),
        ["a", "b"],
      );
      await store.attempted("a", "five", "Error: broker unavailable");
      assert.deepEqual(await store.stuck(1), [
        { id: "a", name: "direct", attempts: 1, error: "Error: broker unavailable" },
      ]);
    } finally {
      await client.end();
    }
  } finally {
    await app.stop();
  }
});
