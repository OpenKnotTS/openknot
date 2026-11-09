import { drizzleUnitOfWork } from "../src/index.ts";
import { createClient } from "@libsql/client";
import { deleted, failure, reader, success } from "@openknot-ts/behavior";
import { command, defaultUnitOfWork, PostCommitError, publisher, query, upserted, writer } from "@openknot-ts/flow";
import type { Deleted, Upserted, UnitOfWorkOptions } from "@openknot-ts/flow";
import { composeModule, defineApplication, runApplication, plug } from "@openknot-ts/wire";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import "@openknot-ts/flow/wire";
import type { TestContext } from "node:test";
import { test } from "node:test";

const records = sqliteTable("records", { id: integer("id").primaryKey() });
const options = (): UnitOfWorkOptions => ({
  mode: "read-write",
  signal: new AbortController().signal,
  actor: undefined,
});
async function database(t: TestContext) {
  const client = createClient({ url: ":memory:" });
  t.after(() => {
    client.close();
  });
  await client.execute("CREATE TABLE records (id INTEGER PRIMARY KEY)");
  return drizzle({ client });
}

test("a native transaction commits its awaited writes and releases its session", async (t) => {
  const db = await database(t),
    uow = drizzleUnitOfWork({ database: db });
  assert.equal(uow.session, undefined);
  assert.equal(await uow.current(), db, "Outside a transaction, IO uses the provided database.");
  const result = await uow.transaction(async () => {
    const before = uow.session;
    assert.equal(before, undefined, "The transaction opens on the first database access.");
    const tx = await uow.current();
    const opened = uow.session;
    assert.ok(opened);
    assert.equal(tx, opened, "Inside a transaction, IO uses its session.");
    await tx.insert(records).values({ id: 1 });
    assert.deepEqual(await tx.select().from(records), [{ id: 1 }]);
    return 42;
  }, options());
  assert.equal(result, 42);
  assert.equal(uow.session, undefined);
  assert.equal(await uow.current(), db);
  assert.deepEqual(await db.select().from(records), [{ id: 1 }]);
});

test("native rollback finishes before the original callback error reaches the caller", async (t) => {
  const db = await database(t),
    uow = drizzleUnitOfWork({ database: db }),
    expected = new Error("abort work");
  await assert.rejects(
    uow.transaction(async () => {
      await (await uow.current()).insert(records).values({ id: 1 });
      throw expected;
    }, options()),
    (error) => error === expected,
  );
  assert.equal(uow.session, undefined);
  assert.deepEqual(await db.select().from(records), []);
  await uow.transaction(async () => {
    await (await uow.current()).insert(records).values({ id: 2 });
  }, options());
  assert.deepEqual(await db.select().from(records), [{ id: 2 }]);
});

test("persistence results return native upsert/delete rows while the outer UoW owns commit and rollback", async (t) => {
  const db = await database(t);
  const rows = sqliteTable("written_rows", {
    id: integer("id").primaryKey(),
    label: text("label").notNull().default("database default"),
  });
  await db.$client.execute(
    "CREATE TABLE written_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'database default')",
  );
  type State = typeof rows.$inferSelect;
  const uow = drizzleUnitOfWork({ database: db });
  const save = writer<(id: number) => Promise<Upserted<State>>>();
  const remove = writer<(id: number) => Promise<Deleted<State>>>();
  const rollback = new Error("reject the change");
  const work = command<{ action: "save" | "delete"; rollback?: boolean }>()({
    requirements: { save, remove },
    run: async (input, ctx) => {
      const result = input.action === "save" ? await ctx.save(1) : await ctx.remove(1);
      return input.rollback ? failure(rollback) : success(result);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            work,
            transaction: plug({ port: defaultUnitOfWork, bind: () => uow }),
            save: plug({
              port: save,
              bind: () => async (id) => {
                const [saved] = await (
                  await uow.current()
                )
                  .insert(rows)
                  .values({ id })
                  .onConflictDoUpdate({ target: rows.id, set: { label: "updated" } })
                  .returning();
                assert.ok(saved);
                return upserted(saved);
              },
            }),
            remove: plug({
              port: remove,
              bind: () => async (id) => {
                const [removed] = await (await uow.current()).delete(rows).where(eq(rows.id, id)).returning();
                assert.ok(removed);
                return deleted(removed);
              },
            }),
          },
        }),
      ],
    }),
  );
  const invoke = (action: "save" | "delete", rollback = false) =>
    app.withScope((scope) => scope.resolve(work)({ action, rollback }));
  try {
    const inserted = await invoke("save");
    assert.ok(!inserted.isError);
    assert.deepEqual(inserted.value, upserted({ id: 1, label: "database default" }));
    assert.ok(Object.isFrozen(inserted.value));
    const updated = await invoke("save");
    assert.ok(!updated.isError);
    assert.deepEqual(updated.value, upserted({ id: 1, label: "updated" }));
    const rejected = await invoke("delete", true);
    assert.ok(rejected.isError);
    assert.equal(rejected.error, rollback);
    assert.deepEqual(await db.select().from(rows), [{ id: 1, label: "updated" }]);
    const removed = await invoke("delete");
    assert.ok(!removed.isError);
    assert.deepEqual(removed.value, deleted({ id: 1, label: "updated" }));
    assert.deepEqual(await db.select().from(rows), []);
    assert.equal(uow.session, undefined);
  } finally {
    await app.stop();
  }
});

test("nested Flow handlers and queries share the native session, then effects precede publication", async (t) => {
  const db = await database(t),
    uow = drizzleUnitOfWork({ database: db }),
    order: string[] = [];
  const save = writer<(id: number) => Promise<void>>(),
    values = reader<() => Promise<readonly number[]>>(),
    events = publisher<number>();
  let savedSession: typeof uow.session;
  const nested = command<number>()({
    requirements: { save, events },
    run: async (id, ctx) => {
      await ctx.save(id);
      await ctx.events.publish(id);
      return success();
    },
  });
  const lookup = query({
    requirements: { values },
    run: async (_, ctx) => success(await ctx.values()),
  });
  const outer = command({
    requirements: { nested, query: lookup },
    run: async (_, ctx) => {
      const changed = await ctx.nested(1);
      assert.ok(!changed.isError);
      const found = await ctx.query();
      assert.ok(!found.isError);
      assert.deepEqual(found.value, [1]);
      ctx.uow.afterCommit(async () => {
        assert.equal(uow.session, undefined);
        assert.equal(await uow.current(), db, "Effects after commit use the provided database.");
        assert.deepEqual(await db.select().from(records), [{ id: 1 }]);
        order.push("effect");
      });
      return success();
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            outer,
            uow: plug({ port: defaultUnitOfWork, bind: () => uow }),
            save: plug({
              port: save,
              bind: () => async (id) => {
                await (await uow.current()).insert(records).values({ id });
                savedSession = uow.session;
                assert.ok(savedSession);
                order.push("write");
              },
            }),
            values: plug({
              port: values,
              bind: () => async () => {
                const session = await uow.current();
                assert.equal(session, savedSession);
                order.push("read");
                return (await session.select().from(records)).map((row) => row.id);
              },
            }),
            events: plug({
              port: events,
              bind: () => async (id) => {
                assert.equal(uow.session, undefined);
                assert.deepEqual(await db.select().from(records), [{ id }]);
                order.push("publish");
              },
            }),
          },
        }),
      ],
    }),
  );
  try {
    assert.ok(!(await app.withScope((scope) => scope.resolve(outer)())).isError);
    assert.deepEqual(order, ["write", "read", "effect", "publish"]);
  } finally {
    await app.stop();
  }
});

test("a nested failed Outcome rolls back native writes and discards effects and publications", async (t) => {
  const db = await database(t),
    uow = drizzleUnitOfWork({ database: db }),
    expected = new Error("business rejection");
  const save = writer<() => Promise<void>>(),
    events = publisher<number>();
  let effects = 0,
    publications = 0;
  const nested = command({
    requirements: { save, events },
    run: async (_, ctx) => {
      await ctx.save();
      ctx.uow.afterCommit(() => {
        effects++;
      });
      await ctx.events.publish(1);
      return failure(expected);
    },
  });
  const outer = command({
    requirements: { nested },
    run: async (_, ctx) => {
      await ctx.nested();
      return success();
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            outer,
            uow: plug({ port: defaultUnitOfWork, bind: () => uow }),
            save: plug({
              port: save,
              bind: () => async () => {
                await (await uow.current()).insert(records).values({ id: 1 });
              },
            }),
            events: plug({
              port: events,
              bind: () => () => {
                publications++;
              },
            }),
          },
        }),
      ],
    }),
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(outer)());
    assert.ok(result.isError);
    assert.equal(result.error, expected);
    assert.deepEqual(await db.select().from(records), []);
    assert.equal(effects, 0);
    assert.equal(publications, 0);
    assert.equal(uow.session, undefined);
  } finally {
    await app.stop();
  }
});

test("an effect failure preserves the native commit and still delivers the publication", async (t) => {
  const db = await database(t),
    uow = drizzleUnitOfWork({ database: db }),
    expected = new Error("cache failed");
  const save = writer<() => Promise<void>>(),
    events = publisher<number>();
  let publications = 0;
  const action = command({
    requirements: { save, events },
    run: async (_, ctx) => {
      await ctx.save();
      await ctx.events.publish(1);
      ctx.uow.afterCommit(() => {
        assert.equal(uow.session, undefined);
        throw expected;
      });
      return success();
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            command: action,
            uow: plug({ port: defaultUnitOfWork, bind: () => uow }),
            save: plug({
              port: save,
              bind: () => async () => {
                await (await uow.current()).insert(records).values({ id: 1 });
              },
            }),
            events: plug({
              port: events,
              bind: () => () => {
                publications++;
              },
            }),
          },
        }),
      ],
    }),
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    assert.ok(result.isError && PostCommitError.is(result.error));
    assert.equal(result.error.committed, true);
    assert.equal(result.error.phase, "effects");
    assert.equal(result.error.cause, expected);
    assert.deepEqual(await db.select().from(records), [{ id: 1 }]);
    assert.equal(publications, 1);
  } finally {
    await app.stop();
  }
});

test("cancellation before admission never starts database work", async (t) => {
  const db = await database(t),
    uow = drizzleUnitOfWork({ database: db }),
    reason = new Error("cancelled");
  let entered = false;
  await assert.rejects(
    uow.transaction(
      async () => {
        entered = true;
      },
      { ...options(), signal: AbortSignal.abort(reason) },
    ),
    (error) => error === reason,
  );
  assert.equal(entered, false);
  assert.equal(uow.session, undefined);
  assert.deepEqual(await db.select().from(records), []);
});

test("overlapping executions have independent native sessions on the same adapter", async (t) => {
  let sequence = 0;
  const firstDatabase = await database(t);
  const secondDatabase = await database(t);
  const selected = drizzle.mock();
  selected.transaction = (work, config) =>
    (++sequence === 1 ? firstDatabase : secondDatabase).transaction(work, config);
  const uow = drizzleUnitOfWork({ database: selected });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const first = uow.transaction(async () => {
    const session = await uow.current();
    await session.insert(records).values({ id: 1 });
    entered.resolve();
    await release.promise;
    assert.equal(uow.session, session);
    return session;
  }, options());
  await entered.promise;
  try {
    const second = await uow.transaction(async () => {
      await Promise.resolve();
      const session = await uow.current();
      await session.insert(records).values({ id: 2 });
      return session;
    }, options());
    assert.ok(second);
    assert.deepEqual(await secondDatabase.select().from(records), [{ id: 2 }]);
    assert.equal(uow.session, undefined);
  } finally {
    release.resolve();
  }
  assert.ok(await first);
  assert.deepEqual(await firstDatabase.select().from(records), [{ id: 1 }]);
  assert.equal(uow.session, undefined);
});

/** The provided database, counting the native transactions it opens. */
async function counted(t: TestContext) {
  const db = await database(t);
  const selected = drizzle.mock();
  const opened = { count: 0 };
  selected.transaction = (work, config) => {
    opened.count++;
    return db.transaction(work, config);
  };
  return { db, selected, opened };
}

test("work that never touches the database opens no native transaction", async (t) => {
  const { selected, opened } = await counted(t);
  const uow = drizzleUnitOfWork({ database: selected });
  assert.equal(await uow.transaction(async () => 42, options()), 42);
  assert.equal(opened.count, 0);
});

test("concurrent first accesses open one native transaction and share its session", async (t) => {
  const { db, selected, opened } = await counted(t);
  const uow = drizzleUnitOfWork({ database: selected });
  await uow.transaction(async () => {
    const [first, second] = await Promise.all([uow.current(), uow.current()]);
    assert.equal(first, second);
    await first.insert(records).values({ id: 1 });
  }, options());
  assert.equal(opened.count, 1);
  assert.deepEqual(await db.select().from(records), [{ id: 1 }]);
});

test("a transaction that fails to open fails the access that opened it", async (t) => {
  const { selected } = await counted(t);
  const refused = new Error("no connection");
  selected.transaction = async () => {
    throw refused;
  };
  const uow = drizzleUnitOfWork({ database: selected });
  await assert.rejects(
    uow.transaction(async () => {
      await uow.current();
    }, options()),
    (error) => error === refused,
  );
  assert.equal(uow.session, undefined);
});

test("committed and rolled-back transactions keep none of their native sessions reachable", async (t) => {
  const gc = (globalThis as { gc?: (options: object) => void }).gc ?? assert.fail("run with node --expose-gc");
  const db = await database(t),
    uow = drizzleUnitOfWork({ database: db }),
    rollback = new Error("roll back");
  const sessions: WeakRef<object>[] = [];
  const write = (id: number) => async () => {
    const session = await uow.current();
    sessions.push(new WeakRef(session));
    await session.insert(records).values({ id });
  };
  for (let id = 0; id < 30; id++) {
    await uow.transaction(write(id), options());
    await assert.rejects(
      uow.transaction(async () => {
        await write(id + 100)();
        throw rollback;
      }, options()),
      (error) => error === rollback,
    );
  }
  // The current job keeps its objects alive until it ends, in the next turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  // A full collection: a single regular cycle can leave unreachable objects behind under load.
  gc({ type: "major", execution: "sync", flavor: "last-resort" });
  assert.equal(sessions.length, 60);
  assert.equal(sessions.filter((session) => session.deref() !== undefined).length, 0);
  assert.equal((await db.select().from(records)).length, 30);
});

test("a native transaction opens outside the async context of the work that first uses it", async (t) => {
  const db = await database(t);
  const execution = new AsyncLocalStorage<string>();
  const opened: (string | undefined)[] = [];
  // The pooled connection a transaction opens outlives the work, so it must not keep the work's context.
  const observed = Object.create(db) as typeof db;
  observed.transaction = ((...args: Parameters<typeof db.transaction>) => {
    opened.push(execution.getStore());
    return db.transaction(...args);
  }) as typeof db.transaction;
  const uow = drizzleUnitOfWork({ database: observed });
  await execution.run("request", () =>
    uow.transaction(async () => {
      assert.equal(execution.getStore(), "request");
      await (await uow.current()).insert(records).values({ id: 1 });
    }, options()),
  );
  assert.deepEqual(opened, [undefined]);
  assert.deepEqual(await db.select().from(records), [{ id: 1 }]);
});
