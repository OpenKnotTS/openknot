import {
  DATABASE_URL,
  REDIS_URL,
  application,
  client,
  code,
  logCreated,
  nextApplied,
  rabbitConnection,
  redis,
  role,
  roleWritten,
  run,
  skip,
  until,
} from "./e2e-application.ts";
import { failure, success } from "@openknot-ts/behavior";
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import { command, defaultUnitOfWork, expose, upserted, writer } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { healthProbes } from "@openknot-ts/health";
import { httpServer } from "@openknot-ts/knot-http-node";
import { defineApplication, plug, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { createClient as createRedisClient } from "redis";

// Outages stop and start the services' docker containers, which must publish fixed host ports.
const containers = {
  postgres: process.env.POSTGRES_CONTAINER ?? "",
  redis: process.env.REDIS_CONTAINER ?? "",
  rabbitmq: process.env.RABBITMQ_CONTAINER ?? "",
};
const outages =
  skip ||
  (Object.values(containers).includes("")
    ? "set POSTGRES_CONTAINER, REDIS_CONTAINER and RABBITMQ_CONTAINER to the services' docker containers"
    : false);
const execute = promisify(execFile);
const docker = (args: readonly string[]) => execute("docker", args);

/**
 * Two turns of the event loop: the current job keeps the objects it created alive until it ends, and closed handles
 * leave libuv in the close phase that follows the turn.
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function activeResources(): Promise<string[]> {
  await settled();
  return process.getActiveResourcesInfo().sort();
}

async function awaitLogs(ids: readonly string[], signal: AbortSignal): Promise<void> {
  const missing = new Set(ids);
  while (missing.size > 0) {
    missing.delete((await logCreated.next(signal)).log.id);
  }
}

test(
  "the application rides out Redis, RabbitMQ and Postgres outages",
  { skip: outages, timeout: 120_000 },
  async (t) => {
    // The acquire timeout outlasts the native client's longest reconnection delay.
    const app = await application({ RABBITMQ_ACQUIRE_TIMEOUT_MS: "40000" });
    const url = app.resolve(httpServer).url;
    const api = client(url);
    const health = async () => (await fetch(`${url}/health`)).status;
    const probes = app.resolve(healthProbes);
    let paused = false;
    try {
      // Redis: health turns down while commands and events go on; reconnecting clears the cache and health is up.
      const lost = Promise.withResolvers<void>();
      const unwatch = app.resolve(redis).connection.watch({ lost: lost.resolve, restored: () => undefined });
      await docker(["stop", containers.redis]);
      await until(lost.promise, t.signal);
      unwatch();
      assert.equal(await health(), 503);
      await api.createRole.mutate(role("o1", "Dispatcher"));
      await awaitLogs(["o1"], t.signal);
      const cleared = nextApplied("clear", undefined, t.signal);
      await docker(["start", containers.redis]);
      await cleared;
      assert.equal(await health(), 200);

      // RabbitMQ: health turns down; a command that commits while the broker is down publishes once it is back.
      const brokerLost = Promise.withResolvers<void>();
      const unwatchBroker = app
        .resolve(rabbitConnection)
        .watch({ lost: brokerLost.resolve, restored: () => undefined });
      await docker(["stop", containers.rabbitmq]);
      await until(brokerLost.promise, t.signal);
      unwatchBroker();
      const brokerDown = await probes.health({ signal: t.signal });
      t.diagnostic(`health while the broker is down: ${JSON.stringify(brokerDown.checks)}`);
      assert.equal(brokerDown.checks.rabbitmq, "down");
      const executing = Promise.withResolvers<void>();
      roleWritten.set("o2", () => executing.resolve());
      const request = api.createRole.mutate(role("o2", "Dispatcher"));
      await until(executing.promise, t.signal);
      await docker(["start", containers.rabbitmq]);
      assert.deepEqual(await until(request, t.signal), { ...role("o2", "Dispatcher"), entity: "role" });
      await awaitLogs(["o2"], t.signal);
      assert.equal((await probes.health({ signal: t.signal })).checks.rabbitmq, "up");

      // Postgres that does not answer: the health deadline and the driver's timeouts answer instead of hanging.
      await docker(["pause", containers.postgres]);
      paused = true;
      assert.equal(await health(), 503);
      await assert.rejects(api.createRole.mutate(role("o3", "Dispatcher")), code("INTERNAL_SERVER_ERROR"));
      await docker(["unpause", containers.postgres]);
      paused = false;
      await api.createRole.mutate(role("o4", "Dispatcher"));
      await awaitLogs(["o4"], t.signal);
      assert.equal(await health(), 200);
      assert.deepEqual(
        (await api.getState.query()).roles.map((entry) => entry.id),
        ["o1", "o2", "o4"],
      );
    } finally {
      if (paused) {
        await docker(["unpause", containers.postgres]);
      }
      await docker(["start", containers.redis, containers.rabbitmq]);
      await app.stop();
    }
  },
);

test("deliveries a killed process left unfinished reach the next process", { skip, timeout: 60_000 }, async (t) => {
  const schema = `openknot_e2e_${randomUUID().slice(0, 8)}`;
  const ids = Array.from({ length: 50 }, (_, index) => `c${index}`);
  const producer = spawn(
    process.execPath,
    [new URL("crash-producer.ts", import.meta.url).pathname, schema, String(ids.length)],
    { env: { ...process.env, E2E_RUN: run }, stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: producer.stdout })[Symbol.asyncIterator]();
  const lock = new pg.Client({ connectionString: DATABASE_URL });
  try {
    assert.equal((await until(lines.next(), t.signal)).value, "ready");
    // Holding the log table keeps the producer's listener inside its deliveries, unacknowledged, until the kill.
    await lock.connect();
    await lock.query("BEGIN");
    await lock.query(`LOCK TABLE ${schema}.logs IN EXCLUSIVE MODE`);
    producer.stdin.write("go\n");
    assert.equal((await until(lines.next(), t.signal)).value, "produced");
  } finally {
    const exited = once(producer, "exit");
    producer.kill("SIGKILL");
    await exited;
    await lock.end();
  }

  // The next process shares the schema and queues; it drops the schema when it stops.
  const app = await application({ E2E_SCHEMA: schema });
  const api = client(app.resolve(httpServer).url);
  try {
    await awaitLogs(ids, t.signal);
    const state = await api.getState.query();
    assert.deepEqual(state.roles.map((entry) => entry.id).sort(), [...ids].sort());
    assert.deepEqual(state.logs.map((entry) => entry.id).sort(), [...ids].sort());
  } finally {
    await app.stop();
  }
});

test(
  "sustained concurrent requests deliver every event and keep the heap flat",
  { skip, timeout: 120_000 },
  async (t) => {
    const gc = (globalThis as { gc?: () => void }).gc ?? assert.fail("run with node --expose-gc");
    const app = await application();
    const api = client(app.resolve(httpServer).url);

    /** Sends `size` requests, 25 at a time, awaits their events, and returns the heap in use after collection. */
    async function round(prefix: string, size: number): Promise<number> {
      const ids = Array.from({ length: size }, (_, index) => `${prefix}${index}`);
      const queue = [...ids];
      await Promise.all(
        Array.from({ length: 25 }, async () => {
          for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
            await api.createRole.mutate(role(id, "Dispatcher"));
          }
        }),
      );
      await awaitLogs(ids, t.signal);
      gc();
      await settled();
      gc();
      return process.memoryUsage().heapUsed;
    }

    try {
      await round("w", 300);
      const first = await round("a", 600);
      await round("b", 600);
      const last = await round("c", 600);
      const grown = (last - first) / 2 ** 20;
      assert.ok(grown < 8, `the heap grew by ${grown.toFixed(1)} MiB over 1200 requests`);
      assert.equal((await api.getState.query()).roles.length, 2100);
    } finally {
      await app.stop();
    }
  },
);

test(
  "a stopped application leaves no connection, timer or process listener of its own",
  { skip, timeout: 60_000 },
  async (t) => {
    const signals = () => ["SIGINT", "SIGTERM"].map((name) => process.listenerCount(name));
    const before = { resources: await activeResources(), signals: signals() };
    const app = await application();
    try {
      const api = client(app.resolve(httpServer).url);
      const ids = Array.from({ length: 40 }, (_, index) => `l${index}`);
      await Promise.all(ids.map((id) => api.createRole.mutate(role(id, "Dispatcher"))));
      await awaitLogs(ids, t.signal);
    } finally {
      await app.stop();
    }
    assert.deepEqual({ resources: await activeResources(), signals: signals() }, before);
  },
);

test(
  "completed requests keep none of their written states reachable through native connections",
  { skip, timeout: 60_000 },
  async (t) => {
    const gc = (globalThis as { gc?: () => void }).gc ?? assert.fail("run with node --expose-gc");
    const app = await application();
    const kept: WeakRef<object>[] = [];
    try {
      const api = client(app.resolve(httpServer).url);
      // Each request runs in its own execution; pooled connections it opens outlive it.
      const ids = Array.from({ length: 40 }, (_, index) => `k${index}`);
      for (const id of ids) {
        roleWritten.set(id, (row) => kept.push(new WeakRef(row)));
      }
      // Each commit evicts its role from Redis after the request returns; the work ends once that is applied.
      const evicted = Promise.all(ids.map((id) => nextApplied("delete", id, t.signal)));
      await Promise.all(ids.map((id) => api.createRole.mutate(role(id, "Dispatcher"))));
      await Promise.all([awaitLogs(ids, t.signal), evicted]);
      for (const id of ids) {
        roleWritten.delete(id);
      }
      await settled();
      gc();
      assert.equal(kept.length, 40);
      assert.equal(kept.filter((row) => row.deref() !== undefined).length, 0);
    } finally {
      await app.stop();
    }
  },
);

test(
  "a dependency that cannot be reached fails startup and leaves no connection or timer behind",
  { skip, timeout: 60_000 },
  async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const { port } = occupied.address() as AddressInfo;
    // Port 9 (discard) has no listener on the test host, so connecting to it is refused at once.
    const unreachable = [
      { PORT: String(port), HTTP_HOST: "127.0.0.1" },
      { RABBITMQ_URL: "amqp://guest:guest@127.0.0.1:9" },
      { DATABASE_URL: "postgres://postgres:openknot@127.0.0.1:9/postgres" },
      { REDIS_URL: "redis://127.0.0.1:9" },
    ];
    // node-redis does not cancel a reconnection delay it already scheduled when destroyed; that timer ends by itself.
    const native = (env: object, list: readonly string[]) =>
      "REDIS_URL" in env ? list.filter((resource) => resource !== "Timeout") : list;
    try {
      for (const env of unreachable) {
        const before = await activeResources();
        await assert.rejects(application(env));
        assert.deepEqual(native(env, await activeResources()), native(env, before), JSON.stringify(env));
      }
    } finally {
      occupied.close();
    }
  },
);

test(
  "stopping while Redis or RabbitMQ is down still closes every connection",
  { skip: outages, timeout: 120_000 },
  async () => {
    // node-redis does not cancel a reconnection delay it already scheduled when destroyed; that timer ends by itself.
    const sockets = async () => (await activeResources()).filter((resource) => resource !== "Timeout");
    try {
      for (const container of [containers.redis, containers.rabbitmq]) {
        const before = await sockets();
        const app = await application();
        await docker(["stop", container]);
        // A release that cannot reach its server reports that failure; it still ends its connection.
        await app.stop().catch(() => undefined);
        assert.deepEqual(await sockets(), before, container);
        await docker(["start", container]);
        if (container === containers.redis) {
          // Its default strategy reconnects until the restarted server answers.
          const native = createRedisClient({ url: REDIS_URL! });
          await native.connect();
          native.destroy();
        }
      }
    } finally {
      await docker(["start", containers.redis, containers.rabbitmq]);
    }
    // The broker answers once it has restarted; the application's startup waits for it.
    const app = await application({ RABBITMQ_STARTUP_TIMEOUT_MS: "60000" });
    await app.stop();
  },
);

test(
  "stopping while a request waits on a server that stopped answering is bounded by native timeouts",
  { skip: outages, timeout: 60_000 },
  async () => {
    for (const container of [containers.postgres, containers.redis]) {
      const app = await application();
      const server = app.resolve(httpServer);
      await docker(["pause", container]);
      try {
        // Postgres holds the write's queries; Redis holds the cache commands around it.
        const admitted = once(server.native, "request");
        const request = client(server.url)
          .createRole.mutate(role(`h${container}`, "Dispatcher"))
          .then(
            () => "created",
            (error: Error) => error.message,
          );
        await admitted;
        // Stopping drains the request; the drivers' timeouts end what the server holds, and failed releases report.
        const [outcome] = await Promise.all([request, app.stop().catch(() => undefined)]);
        // A cache that cannot be reached fails no command; a database that does not answer fails it by its timeout.
        assert.equal(outcome === "created", container === containers.redis, outcome);
        assert.doesNotMatch(outcome, /not accepting invocations/);
      } finally {
        await docker(["unpause", container]);
      }
    }
  },
);

test(
  "executions cancelled or failing inside their transactions return every pooled connection and keep no partial write",
  { skip, timeout: 60_000 },
  async () => {
    const name = `openknot_pool_${run}`;
    const records = pgTable(name, { id: text().primaryKey() });
    // Two connections for thirty executions: one that never returned would leave the rest waiting.
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`);
    const database = drizzle({ client: pool });
    const transaction = unit({ factory: () => drizzleUnitOfWork({ database }) });
    const save = writer<(id: string) => Promise<ReturnType<typeof upserted<{ entity: "record"; id: string }>>>>();
    let writing = 0;
    const bothWriting = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const create = command<string>()({
      requirements: { save },
      async run(id, ctx) {
        await ctx.save(id);
        if (++writing === 2) {
          bothWriting.resolve();
        }
        await Promise.race([
          proceed.promise,
          new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true })),
        ]);
        if (id.startsWith("rejected")) {
          return failure(new Error(`${id} was rejected`));
        }
        if (id.startsWith("thrown")) {
          throw new Error(`${id} threw`);
        }
        return success();
      },
    });
    const endpoint = expose({ handler: create });
    const app = await runApplication(
      defineApplication({
        modules: [
          provideFlow([endpoint]),
          providePlugs([
            transaction,
            plug({ port: defaultUnitOfWork, requirements: { transaction }, bind: ({ transaction }) => transaction }),
            plug({
              port: save,
              requirements: { transaction },
              bind:
                ({ transaction }) =>
                async (id) => {
                  await (await transaction.current()).insert(records).values({ id });
                  return upserted({ entity: "record" as const, id });
                },
            }),
          ]),
        ],
      }),
      { stopOn: [] },
    );
    try {
      const calls = Array.from({ length: 30 }, (_, index) => {
        const id = `${["rejected", "thrown", "created", "created", "created"][index % 5]}${index}`;
        const caller = new AbortController();
        const outcome = app
          .resolve(endpoint)({ input: id, signal: caller.signal })
          .then(
            () => id,
            () => undefined,
          );
        return { caller, outcome };
      });
      await bothWriting.promise;
      // Half of the callers go away: some while their transaction holds a connection, the rest while they wait for one.
      calls.forEach(({ caller }, index) => index % 2 === 0 && caller.abort(new Error("caller went away")));
      proceed.resolve();
      const created = (await Promise.all(calls.map(({ outcome }) => outcome))).filter((id) => id !== undefined);
      const rows = await pool.query<{ id: string }>(`SELECT id FROM ${name}`);
      assert.deepEqual(rows.rows.map(({ id }) => id).sort(), created.sort());
      assert.ok(created.length > 0);
      assert.deepEqual([pool.totalCount, pool.idleCount, pool.waitingCount], [2, 2, 0]);
    } finally {
      await app.stop();
      await pool.query(`DROP TABLE ${name}`);
      await pool.end();
    }
  },
);
