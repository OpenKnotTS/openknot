import { rabbitmqPublisher } from "../src/publisher/publisher.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Connection } from "rabbitmq-client";

const encode = (input: number) => Buffer.from(String(input));
const signal = new AbortController().signal;
const decode = ({ body }: { body: unknown }) => {
  const number = Number((body as Buffer).toString());
  if (!Number.isFinite(number)) {
    throw new TypeError("Invalid number");
  }
  return number;
};
async function broker(t: TestContext) {
  assert.ok(process.env.RABBITMQ_URL, "Set RABBITMQ_URL to run real-broker tests (no mock fallback)");
  const cleanups: (() => void | Promise<unknown>)[] = [];
  const cleanup = (fn: () => void | Promise<unknown>) => {
    cleanups.push(fn);
  };
  t.after(async () => {
    const errors: unknown[] = [];
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Broker test cleanup failed");
    }
  });
  const connection = new Connection({
    url: process.env.RABBITMQ_URL,
    connectionTimeout: 3_000,
    acquireTimeout: 3_000,
    retryLow: 50,
    retryHigh: 100,
  });
  const errors: unknown[] = [];
  connection.on("error", (error) => {
    errors.push(error);
  });
  cleanup(() => connection.close());
  await connection.onConnect(5_000);
  const channel = await connection.acquire();
  cleanup(() => channel.close());
  const queue = `openknot.${randomUUID()}`;
  await channel.queueDeclare({ queue, durable: true });
  cleanup(() => connection.queueDelete({ queue }));
  return { connection, channel, queue, errors, cleanup };
}

test(
  "real broker: initialization declares the topology, an alternate exchange keeps unroutable messages, and missing exchanges and nacks reject",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { connection, channel, queue, cleanup } = await broker(t);
    const routed = `${queue}.routed`,
      unrouted = `${queue}.unrouted`,
      kept = `${queue}.kept`;
    cleanup(() => connection.exchangeDelete({ exchange: routed }));
    cleanup(() => connection.exchangeDelete({ exchange: unrouted }));
    cleanup(() => connection.queueDelete({ queue: kept }));
    const managed = await rabbitmqPublisher({
      connection,
      exchange: routed,
      routingKey: "absent",
      encode,
      topology: {
        queues: [{ queue: kept, durable: true }],
        exchanges: [
          { exchange: unrouted, type: "fanout", durable: true },
          { exchange: routed, type: "direct", durable: true, arguments: { "alternate-exchange": unrouted } },
        ],
        queueBindings: [{ queue: kept, exchange: unrouted }],
      },
      signal,
    });
    cleanup(() => managed.release());
    // The exchange exists before anything is published.
    await channel.exchangeDeclare({ exchange: routed, passive: true });
    // No binding accepts the routing key: the broker routes the message to the alternate exchange.
    await managed.value.publish(1);
    const retained = await connection.basicGet({ queue: kept, noAck: true });
    assert.equal(retained === undefined ? undefined : decode(retained), 1);
    // A declaration the broker refuses fails initialization, before a native publisher exists.
    await assert.rejects(
      rabbitmqPublisher({
        connection,
        exchange: "",
        routingKey: queue,
        encode,
        topology: { queues: [{ queue }] },
        signal,
      }),
      /PRECONDITION_FAILED/,
    );

    const missing = await rabbitmqPublisher({
      connection,
      exchange: `${queue}.absent`,
      routingKey: "any",
      encode,
      signal,
    });
    cleanup(() => missing.release());
    await assert.rejects(missing.value.publish(1), /NOT_FOUND/);
    await channel.exchangeDeclare({ exchange: `${queue}.absent`, type: "direct", durable: true });
    await channel.queueBind({ queue, exchange: `${queue}.absent`, routingKey: "any" });
    cleanup(() => connection.exchangeDelete({ exchange: `${queue}.absent` }));
    await missing.value.publish(1);

    const fullQueue = `${queue}.full`;
    await channel.queueDeclare({
      queue: fullQueue,
      durable: true,
      arguments: { "x-max-length": 1, "x-overflow": "reject-publish" },
    });
    cleanup(() => connection.queueDelete({ queue: fullQueue }));
    const bounded = await rabbitmqPublisher({ connection, exchange: "", routingKey: fullQueue, encode, signal });
    cleanup(() => bounded.release());
    await bounded.value.publish(1);
    await assert.rejects(
      bounded.value.publish(2),
      (error) => error instanceof Error && "code" in error && error.code === "NACK",
    );
  },
);
