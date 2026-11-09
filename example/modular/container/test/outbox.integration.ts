import type { Attempt, Delivery } from "./outbox-application.ts";
import {
  createSchema,
  dropSchema,
  outboxApplication,
  placeOrder,
  recorder,
  rows,
  run,
  skip,
} from "./outbox-application.ts";
import { healthProbes } from "@openknot-ts/health";
import { httpServer } from "@openknot-ts/knot-http-node";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { promisify } from "node:util";

// Outages stop and pause the services' docker containers, which must publish fixed host ports.
const containers = { postgres: process.env.POSTGRES_CONTAINER ?? "", rabbitmq: process.env.RABBITMQ_CONTAINER ?? "" };
const outages =
  skip ||
  (containers.postgres === "" || containers.rabbitmq === ""
    ? "set POSTGRES_CONTAINER and RABBITMQ_CONTAINER to the services' docker containers"
    : false);
const execute = promisify(execFile);
const docker = (args: readonly string[]) => execute("docker", args);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A fresh schema with the order and outbox tables, dropped after the test. */
async function setup(t: TestContext) {
  const schema = `openknot_outbox_${randomUUID().slice(0, 8)}`;
  await createSchema(schema);
  t.after(() => dropSchema(schema));
  return { schema, attempts: recorder<Attempt>(), deliveries: recorder<Delivery>() };
}

function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { readonly port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test(
  "an order's event goes from HTTP through PostgreSQL and RabbitMQ to a listener with one messageId",
  { skip, timeout: 60_000 },
  async (t) => {
    const { schema, attempts, deliveries } = await setup(t);
    const app = await outboxApplication({ schema, attempts, deliveries });
    try {
      assert.equal(await placeOrder(app.resolve(httpServer).url, "o1"), 201);
      await deliveries.until((items) => items.length === 1, t.signal);
      // RabbitMQ may hand the message to the listener before the publisher's confirm returns.
      await attempts.until((items) => items.length === 1, t.signal);
      const [delivery] = deliveries.items;
      assert.match(delivery!.messageId ?? "", uuid);
      assert.deepEqual(attempts.items, [{ messageId: delivery!.messageId, order: "o1", outcome: "sent" }]);
      assert.deepEqual(await rows(schema, "SELECT id FROM orders"), [{ id: "o1" }]);
    } finally {
      await app.stop();
    }
    assert.deepEqual(await rows(schema, "SELECT id FROM openknot_outbox"), []);
  },
);

test(
  "a broker outage keeps records in order, and the restored connection delivers them",
  { skip: outages, timeout: 120_000 },
  async (t) => {
    const { schema, attempts, deliveries } = await setup(t);
    const app = await outboxApplication({ schema, attempts, deliveries, env: { RABBITMQ_ACQUIRE_TIMEOUT_MS: "2000" } });
    const url = app.resolve(httpServer).url;
    let down = false;
    try {
      await docker(["stop", containers.rabbitmq]);
      down = true;
      assert.equal(await placeOrder(url, "a1"), 201, "the request does not wait for the broker");
      await attempts.until((items) => items.some((item) => item.order === "a1" && item.outcome === "failed"), t.signal);
      assert.equal(await placeOrder(url, "a2"), 201);
      const pending = await rows(schema, "SELECT id, attempts FROM openknot_outbox ORDER BY sequence");
      assert.equal(pending.length, 2);
      assert.ok(Number(pending[0]!.attempts) >= 1);

      // The restored connection delivers what the outage left, without a new request.
      await docker(["start", containers.rabbitmq]);
      down = false;
      await deliveries.until((items) => items.some((item) => item.order === "a2"), t.signal);
      // RabbitMQ may hand the message to the listener before the publisher's confirm returns.
      await attempts.until((items) => items.some((item) => item.order === "a2" && item.outcome === "sent"), t.signal);
      assert.deepEqual(
        attempts.items.filter((item) => item.outcome === "sent").map((item) => item.order),
        ["a1", "a2"],
      );
      assert.equal(deliveries.items.find((item) => item.order === "a1")?.messageId, pending[0]!.id);
    } finally {
      t.diagnostic(`attempts ${JSON.stringify(attempts.items)} deliveries ${JSON.stringify(deliveries.items)}`);
      if (down) {
        await docker(["start", containers.rabbitmq]);
      }
      await app.stop();
    }
    assert.deepEqual(await rows(schema, "SELECT id FROM openknot_outbox"), []);
  },
);

test(
  "a record a killed process was sending is delivered by the next process once its lease ends",
  { skip, timeout: 60_000 },
  async (t) => {
    const { schema, attempts, deliveries } = await setup(t);
    const producer = spawn(process.execPath, [new URL("outbox-producer.ts", import.meta.url).pathname, schema, "k1"], {
      env: { ...process.env, E2E_RUN: run },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lines = createInterface({ input: producer.stdout })[Symbol.asyncIterator]();
    try {
      assert.equal((await within(lines.next(), t.signal)).value, "held");
    } finally {
      const exited = once(producer, "exit");
      producer.kill("SIGKILL");
      await exited;
    }
    const [orphan] = await rows(schema, "SELECT id, claimed_by FROM openknot_outbox");
    assert.ok(orphan?.claimed_by, "the killed process still holds its claim");

    const app = await outboxApplication({ schema, attempts, deliveries });
    try {
      await deliveries.until((items) => items.length === 1, t.signal);
      assert.deepEqual(deliveries.items, [{ messageId: orphan.id, order: "k1" }]);
    } finally {
      await app.stop();
    }
    assert.deepEqual(await rows(schema, "SELECT id FROM openknot_outbox"), []);
  },
);

test(
  "two instances on one database deliver each event once, in insertion order",
  { skip, timeout: 60_000 },
  async (t) => {
    const { schema, attempts, deliveries } = await setup(t);
    const instances = await Promise.all(
      [1, 2].map(() => outboxApplication({ schema, attempts, deliveries, leaseMs: 5_000 })),
    );
    const ids = Array.from({ length: 20 }, (_, index) => `m${String(index).padStart(2, "0")}`);
    try {
      for (const [index, id] of ids.entries()) {
        assert.equal(await placeOrder(instances[index % 2]!.resolve(httpServer).url, id), 201);
      }
      await deliveries.until((items) => new Set(items.map((item) => item.order)).size === ids.length, t.signal);
    } finally {
      await Promise.all(instances.map((instance) => instance.stop()));
    }
    assert.deepEqual(
      attempts.items.filter((item) => item.outcome === "sent").map((item) => item.order),
      ids,
    );
    assert.deepEqual(deliveries.items.map((item) => item.order).sort(), ids);
    assert.equal(new Set(deliveries.items.map((item) => item.messageId)).size, ids.length);
    assert.deepEqual(await rows(schema, "SELECT id FROM openknot_outbox"), []);
  },
);

test(
  "PostgreSQL unreachable at startup fails it, and PostgreSQL that stops answering turns health down",
  { skip: outages, timeout: 60_000 },
  async (t) => {
    const { schema, attempts, deliveries } = await setup(t);
    await assert.rejects(
      outboxApplication({
        schema,
        attempts,
        deliveries,
        env: { DATABASE_URL: `postgres://app:app@127.0.0.1:${await closedPort()}/app` },
      }),
      /ECONNREFUSED/,
    );

    const app = await outboxApplication({ schema, attempts, deliveries });
    const probes = app.resolve(healthProbes);
    const checks = async () => (await probes.health({ signal: t.signal })).checks;
    let paused = false;
    try {
      // The broker's check stays up throughout: one dependency's outage leaves the others' checks alone.
      assert.deepEqual(await checks(), { postgres: "up", rabbitmq: "up" });
      await docker(["pause", containers.postgres]);
      paused = true;
      assert.deepEqual(await checks(), { postgres: "down", rabbitmq: "up" });
      await docker(["unpause", containers.postgres]);
      paused = false;
      assert.deepEqual(await checks(), { postgres: "up", rabbitmq: "up" });
    } finally {
      if (paused) {
        await docker(["unpause", containers.postgres]);
      }
      await app.stop();
    }
  },
);
