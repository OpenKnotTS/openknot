import { drizzleOutbox } from "../src/sqlite.ts";
import { createClient } from "@libsql/client";
import { error, failure, success } from "@openknot-ts/behavior";
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import type { PublishOptions } from "@openknot-ts/flow";
import { command, defaultUnitOfWork, InternalFlowError, publisher, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { outbox, outboxStore } from "@openknot-ts/outbox";
import type { Definition } from "@openknot-ts/wire";
import { config, composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("outbox lease settings resolve from validated requirements instead of being fixed at declaration", async () => {
  const { db, close } = await database();
  const transaction = unit({ factory: () => drizzleUnitOfWork({ database: db }) });
  const settings = config({ OUTBOX_LEASE_MS: Number });
  const storage = drizzleOutbox({
    transaction,
    requirements: { settings },
    leaseMs: ({ settings }) => settings.OUTBOX_LEASE_MS,
  });
  const definition = defineApplication({ modules: [composeModule({ providers: { storage } })] });
  try {
    await assert.rejects(runApplication(definition, { env: { OUTBOX_LEASE_MS: "0" }, stopOn: [] }), /leaseMs/);
    const app = await runApplication(definition, { env: { OUTBOX_LEASE_MS: "60000" }, stopOn: [] });
    try {
      assert.deepEqual(await app.resolve(outboxStore).stuck(1), []);
    } finally {
      await app.stop();
    }
  } finally {
    await close();
  }
});

const roles = sqliteTable("roles", { id: text("id").primaryKey(), name: text("name").notNull() });
const Refused = error("Refused");

async function database() {
  const directory = await mkdtemp(join(tmpdir(), "openknot-outbox-"));
  const client = createClient({ url: `file:${join(directory, "app.db")}` });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  await client.execute(
    `CREATE TABLE openknot_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      message TEXT NOT NULL, propagation TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, claimed_by TEXT, claimed_until INTEGER)`,
  );
  const rows = async (sql: string) => (await client.execute(sql)).rows.map((row) => ({ ...row }));
  return {
    db: drizzle({ client }),
    client,
    rows,
    async close() {
      client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function application(db: ReturnType<typeof drizzle>, options: { readonly drizzleWork: boolean }) {
  const sent: { readonly message: unknown; readonly id: string | undefined }[] = [];
  const delivered = Promise.withResolvers<void>();
  const transaction = unit({ factory: () => drizzleUnitOfWork({ database: db }) });
  const selected = plug({
    port: defaultUnitOfWork,
    requirements: { transaction },
    bind: ({ transaction }) => transaction,
  });
  const events = publisher<{ readonly name: string }>();
  const saveRole = writer<(role: { readonly id: string; readonly name: string }) => Promise<void>>();
  const change = command<{ readonly id: string; readonly name: string }>()({
    requirements: { saveRole, events },
    run: async (role, ctx) => {
      await ctx.saveRole(role);
      await ctx.events.publish({ name: role.name });
      return role.name === "refused" ? failure(Refused()) : success();
    },
  });
  const native = plug({
    port: events,
    bind: () => (message: { readonly name: string }, publishOptions: PublishOptions) =>
      void (sent.push({ message, id: publishOptions.messageId }), delivered.resolve()),
  });
  const roleWriter = plug({
    port: saveRole,
    requirements: { transaction },
    bind:
      ({ transaction }) =>
      async (role) => {
        await (await transaction.current()).insert(roles).values(role);
      },
  });
  const definitions: Definition[] = [
    change,
    transaction,
    roleWriter,
    outbox({ name: "roles", plug: native }),
    drizzleOutbox({ transaction }),
    ...(options.drizzleWork ? [selected] : []),
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

test("a committed change and its publication are stored together and delivered after commit", async () => {
  const { db, rows, close } = await database();
  const { start, change, sent, delivered } = application(db, { drizzleWork: true });
  const app = await start();
  try {
    assert.ok(!(await app.withScope((scope) => scope.resolve(change)({ id: "r1", name: "admin" }))).isError);
    await delivered;
  } finally {
    await app.stop();
  }
  assert.deepEqual(await rows("SELECT id, name FROM roles"), [{ id: "r1", name: "admin" }]);
  assert.deepEqual(
    sent.map((each) => each.message),
    [{ name: "admin" }],
  );
  assert.deepEqual(await rows("SELECT * FROM openknot_outbox"), []);
  await close();
});

test("a rollback stores neither the change nor its publication", async () => {
  const { db, rows, close } = await database();
  const { start, change, sent } = application(db, { drizzleWork: true });
  const app = await start();
  try {
    const result = await app.withScope((scope) => scope.resolve(change)({ id: "r2", name: "refused" }));
    assert.ok(result.isError && Refused.is(result.error));
  } finally {
    await app.stop();
  }
  assert.deepEqual(await rows("SELECT * FROM roles"), []);
  assert.deepEqual(await rows("SELECT * FROM openknot_outbox"), []);
  assert.equal(sent.length, 0);
  await close();
});

test("a publication outside the Drizzle transaction fails and rolls back", async () => {
  const { db, rows, close } = await database();
  const { start, change, sent } = application(db, { drizzleWork: false });
  const app = await start();
  try {
    const result = await app.withScope((scope) => scope.resolve(change)({ id: "r3", name: "admin" }));
    assert.ok(result.isError && InternalFlowError.is(result.error));
    assert.match(String((result.error.cause as Error).message), /Drizzle Unit of Work's transaction/);
  } finally {
    await app.stop();
  }
  assert.deepEqual(await rows("SELECT * FROM openknot_outbox"), []);
  assert.equal(sent.length, 0);
  await close();
});

test("claims hold a name for one owner until their lease ends, in insertion order", async () => {
  const { db, client, rows, close } = await database();
  const { start } = application(db, { drizzleWork: true });
  const app = await start();
  try {
    const store = app.resolve(outboxStore);
    for (const id of ["a", "b", "c"]) {
      await client.execute({
        sql: "INSERT INTO openknot_outbox (id, name, message) VALUES (?, 'direct', ?)",
        args: [id, JSON.stringify({ id })],
      });
    }
    const first = await store.claim("direct", "one", 2);
    assert.deepEqual(
      first.map((record) => [record.id, record.message]),
      [
        ["a", { id: "a" }],
        ["b", { id: "b" }],
      ],
    );
    assert.deepEqual(await store.claim("direct", "two", 10), []);
    assert.ok(((await store.heldFor("direct", "two")) ?? 0) > 0);
    assert.equal(await store.heldFor("direct", "one"), undefined);

    assert.equal(await store.renew(["a", "b"], "one"), true);
    assert.equal(await store.renew(["a", "b"], "two"), false);
    await store.attempted("a", "two", "Error: broker unavailable");
    assert.deepEqual(await store.stuck(1, "direct"), [], "a record another owner holds is left untouched");
    await store.attempted("a", "one", "Error: broker unavailable");
    assert.deepEqual(await store.stuck(1, "direct"), [
      { id: "a", name: "direct", attempts: 1, error: "Error: broker unavailable" },
    ]);
    assert.deepEqual(await store.claim("direct", "two", 10), [], "b is still held by one");

    await client.execute("UPDATE openknot_outbox SET claimed_until = 0 WHERE claimed_by = 'one'");
    assert.deepEqual(
      (await store.claim("direct", "two", 10)).map((record) => record.id),
      ["a", "b", "c"],
    );

    await store.complete(["a"]);
    await store.discard("b");
    await store.release(["c"], "one");
    assert.deepEqual(await rows("SELECT claimed_by FROM openknot_outbox WHERE id = 'c'"), [{ claimed_by: "two" }]);
    await store.release(["c"], "two");
    assert.deepEqual(await rows("SELECT id, claimed_by FROM openknot_outbox"), [{ id: "c", claimed_by: null }]);
  } finally {
    await app.stop();
    await close();
  }
});
