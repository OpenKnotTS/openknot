import {
  REDIS_URL,
  application,
  cacheKey,
  client,
  code,
  database,
  findRole,
  logCreated,
  nextApplied,
  role,
  roleRejected,
  roleWritten,
  skip,
  sourceReads,
  until,
} from "./e2e-application.ts";
import { httpServer } from "@openknot-ts/knot-http-node";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "redis";

test(
  "HTTP requests run through Postgres, RabbitMQ and Redis, and failed work publishes nothing",
  { skip, timeout: 30_000 },
  async (t) => {
    const app = await application();
    const url = app.resolve(httpServer).url;
    const api = client(url);
    try {
      // Probes: the database check runs against Postgres and the cache's against Redis.
      const health = await fetch(`${url}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "up" });

      // Failed requests: no credentials, invalid state, and a name Postgres refuses at commit after the work ran.
      await assert.rejects(client(url, "invalid").createRole.mutate(role("r0", "Dispatcher")), code("UNAUTHORIZED"));
      await assert.rejects(api.createRole.mutate(role("r0", " ")), code("INTERNAL_SERVER_ERROR"));
      await assert.rejects(api.createRole.mutate(role("r0", "Unlisted")), code("INTERNAL_SERVER_ERROR"));

      // The first LogCreated is r1's: none of the failed requests published a RoleChanged.
      const created = await api.createRole.mutate(role("r1", "Dispatcher"));
      assert.deepEqual(created, { ...role("r1", "Dispatcher"), entity: "role" });
      const log = await logCreated.next(t.signal);
      assert.deepEqual(log, { type: "LogCreated", log: { id: "r1", action: 'Created role "Dispatcher"' } });
      assert.deepEqual(await api.getState.query(), { roles: [role("r1", "Dispatcher")], logs: [log.log] });

      // Redis answers the second read; a committed change of the role evicts it, so the next read is current.
      const read = () => app.withScope((scope) => scope.resolve(findRole)("r1"));
      const reads = sourceReads;
      const filled = nextApplied("set", "r1", t.signal);
      assert.equal((await read())?.name, "Dispatcher");
      await filled;
      assert.equal((await read())?.name, "Dispatcher");
      assert.equal(sourceReads, reads + 1);
      const evicted = nextApplied("delete", "r1", t.signal);
      await api.createRole.mutate(role("r1", "Manager"));
      await evicted;
      assert.equal((await read())?.name, "Manager");
      assert.equal(sourceReads, reads + 2);
      assert.equal((await logCreated.next(t.signal)).log.action, 'Created role "Manager"');

      // Concurrent requests run in their own transactions on the shared pool, and each delivers its own events.
      const concurrent = ["r2", "r3", "r4"];
      await Promise.all(concurrent.map((id) => api.createRole.mutate(role(id, "Dispatcher"))));
      const delivered = await Promise.all(concurrent.map(() => logCreated.next(t.signal)));
      assert.deepEqual(delivered.map((event) => event.log.id).sort(), concurrent);
      const state = await api.getState.query();
      assert.deepEqual(
        state.roles.map((entry) => entry.id),
        ["r1", ...concurrent],
      );
      assert.deepEqual(
        state.logs.map((entry) => entry.id),
        ["r1", ...concurrent],
      );
    } finally {
      await app.stop();
      const native = createClient({ url: REDIS_URL! });
      await native.connect();
      try {
        await native.del(cacheKey("r1"));
      } finally {
        await native.close();
      }
    }
  },
);

test(
  "a listener that fails rejects its delivery to the dead-letter queue and keeps consuming",
  { skip, timeout: 30_000 },
  async (t) => {
    const app = await application();
    const api = client(app.resolve(httpServer).url);
    try {
      // The role commits and its RoleChanged is published; writing its log violates the check.
      await api.createRole.mutate(role("a1", "Auditor"));
      assert.deepEqual(await roleRejected.next(t.signal), { type: "RoleChanged", role: role("a1", "Auditor") });

      // The consumer goes on with the next delivery.
      await api.createRole.mutate(role("d1", "Dispatcher"));
      assert.equal((await logCreated.next(t.signal)).log.id, "d1");
      const state = await api.getState.query();
      assert.deepEqual(
        state.roles.map((entry) => entry.id),
        ["a1", "d1"],
      );
      assert.deepEqual(
        state.logs.map((entry) => entry.id),
        ["d1"],
      );
    } finally {
      await app.stop();
    }
  },
);

test("stopping the application lets an HTTP request already executing finish", { skip, timeout: 30_000 }, async (t) => {
  const executing = Promise.withResolvers<void>();
  roleWritten.set("s1", () => executing.resolve());
  const app = await application();
  const api = client(app.resolve(httpServer).url);
  // Holding the role name locks the row the request's commit must check, so the request waits until it is released.
  const lock = await app.resolve(database).$client.connect();
  let stopping: Promise<void> | undefined;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT name FROM role_names WHERE name = 'Dispatcher' FOR UPDATE");
    const request = api.createRole.mutate(role("s1", "Dispatcher"));
    await until(executing.promise, t.signal);
    stopping = app.stop();
    assert.equal(app.status, "stopping");
    await lock.query("COMMIT");
    assert.deepEqual(await until(request, t.signal), { ...role("s1", "Dispatcher"), entity: "role" });
  } finally {
    lock.release();
    await (stopping ?? app.stop());
  }
});
