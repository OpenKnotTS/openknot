import type { RabbitConsumerConnection } from "../src/index.ts";
import { rabbitmqListener } from "../src/listener/listener.ts";
import type { RabbitFailureKind } from "../src/listener/listener.ts";
import { rabbitmqPublisher } from "../src/publisher/publisher.ts";
import { success } from "@openknot-ts/behavior";
import { command, expose, listener, PostCommitError, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { defineApplication, plug, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Connection } from "rabbitmq-client";
import type { Consumer } from "rabbitmq-client";

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
  "real broker: Wire publisher -> confirm -> listener -> command, staged publication and metadata",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { connection, queue, cleanup } = await broker(t);
    const propagation = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    };
    const seen = Promise.withResolvers<unknown>();
    const order: string[] = [];
    let native: Consumer | undefined;
    const supplied = unit({ factory: () => connection });
    const events = publisher<number>();
    const write = command<number>()({
      run: (input, ctx) => {
        assert.equal(input, 42);
        seen.resolve(ctx.actor);
        return success();
      },
    });
    const received = listener<number>()({
      requirements: { write },
      run: async (input, ctx) => {
        assert.ok(ctx.trigger.messageId);
        assert.equal(ctx.trigger.attempt, undefined);
        return ctx.write(input);
      },
    });
    const send = command<number>()({
      requirements: { events },
      run: async (input, ctx) => {
        await ctx.events.publish(input);
        assert.equal(native?.stats.acknowledged, 0);
        ctx.uow.afterCommit(() => {
          order.push("committed");
        });
        return success();
      },
    });
    const sendInput = expose<number>()({ requirements: { send }, run: (input, ctx) => ctx.send(input) });
    const sending = resource({
      requirements: { supplied },
      initialize: ({ supplied }, { signal }) =>
        rabbitmqPublisher({
          connection: supplied,
          signal,
          exchange: "",
          routingKey: queue,
          encode,
          properties: () => {
            assert.deepEqual(order, ["committed"]);
            return { durable: true };
          },
        }),
    });
    const publishing = plug({
      port: events,
      requirements: { sending },
      bind: ({ sending }) => sending.publish,
    });
    const consuming = plug({
      port: received,
      requirements: { supplied },
      bind: (context) =>
        rabbitmqListener(
          {
            connection: {
              createConsumer: (options, handler) => (native = context.supplied.createConsumer(options, handler)),
            },
            consumer: {
              queue,
              consumerTag: `${queue}.input`,
              queueOptions: { durable: true },
              qos: { prefetchCount: 4 },
            },
            decode,
            failurePolicy: (failed) => {
              throw failed.error;
            },
            onError: (error) => {
              throw error;
            },
          },
          {
            ...context,
            invoke: (request) => {
              assert.deepEqual(request.propagation, propagation);
              return context.invoke(request);
            },
          },
        ),
    });
    const app = await runApplication(
      defineApplication({
        modules: [provideFlow([events, received, sendInput]), providePlugs([sending, publishing, consuming])],
      }),
    );
    cleanup(() => app.stop());
    await app.withScope((scope) => scope.resolve(sendInput)({ input: 42, propagation }));
    const execution = await seen.promise;
    assert.equal(execution, undefined);
    assert.equal(native?.consumerTag, `${queue}.input`);
    await app.stop();
    assert.equal(native?.stats.acknowledged, 1);
    // The caller still owns a live connection after every plug was released.
    const channel = await connection.acquire();
    await channel.close();
  },
);

test(
  "real broker: malformed and failed outcomes use native dead lettering; post-commit can be acknowledged explicitly",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { connection, channel, queue, cleanup } = await broker(t);
    const work = `${queue}.work`,
      dlx = `${queue}.dlx`;
    await channel.exchangeDeclare({ exchange: dlx, type: "direct", durable: true });
    await channel.queueBind({ queue, exchange: dlx, routingKey: "failed" });
    await channel.queueDeclare({
      queue: work,
      durable: true,
      arguments: { "x-dead-letter-exchange": dlx, "x-dead-letter-routing-key": "failed" },
    });
    cleanup(async () => {
      await connection.queueDelete({ queue: work });
      await connection.exchangeDelete({ exchange: dlx });
    });
    const dead = Promise.withResolvers<void>();
    const received: unknown[] = [];
    const quarantine = connection.createConsumer(
      { queue, queueOptions: { durable: true }, requeue: false },
      (message) => {
        received.push(message.body);
        if (received.length === 2) {
          dead.resolve();
        }
      },
    );
    quarantine.on("error", (error) => {
      dead.reject(error);
    });
    cleanup(() => quarantine.close());
    const failures: RabbitFailureKind[] = [];
    let native: Consumer | undefined;
    const source = new AbortController();
    const handle = await rabbitmqListener(
      {
        connection: { createConsumer: (options, handler) => (native = connection.createConsumer(options, handler)) },
        consumer: {
          queue: work,
          queueOptions: {
            durable: true,
            arguments: { "x-dead-letter-exchange": dlx, "x-dead-letter-routing-key": "failed" },
          },
          qos: { prefetchCount: 1 },
        },
        decode,
        failurePolicy: ({ kind }) => {
          failures.push(kind);
          return kind === "post-commit" ? "ack" : "reject";
        },
        onError: (error) => {
          dead.reject(error);
        },
      },
      {
        signal: source.signal,
        invoke: async ({ input }) => {
          throw input === 2 ? PostCommitError("publications", "confirm failed") : new Error("rejected");
        },
      },
    );
    cleanup(() => handle.release());
    const sender = await rabbitmqPublisher({ connection, exchange: "", routingKey: work, encode, signal });
    cleanup(() => sender.release());
    await sender.value.publish(NaN);
    await sender.value.publish(1);
    await sender.value.publish(2);
    await dead.promise;
    await handle.release();
    assert.deepEqual(failures, ["decode", "handler", "post-commit"]);
    assert.equal(native?.stats.dropped, 2);
    assert.equal(native?.stats.acknowledged, 1);
    assert.equal(received.length, 2);
  },
);

test(
  "real broker: prefetch bounds work and shutdown drains an admitted handler before ack/channel release",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { connection, channel, queue, cleanup } = await broker(t);
    const admitted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let native: Consumer | undefined;
    let invocations = 0;
    const handle = await rabbitmqListener(
      {
        connection: { createConsumer: (options, handler) => (native = connection.createConsumer(options, handler)) },
        consumer: { queue, queueOptions: { durable: true }, qos: { prefetchCount: 1 } },
        decode,
        failurePolicy: () => "reject",
        onError: (error) => {
          throw error;
        },
      },
      {
        signal: controller.signal,
        invoke: async (request) => {
          invocations++;
          assert.equal(request.signal, undefined);
          admitted.resolve();
          await release.promise;
          return success();
        },
      },
    );
    cleanup(async () => {
      release.resolve();
      await handle.release();
    });
    const sending = await rabbitmqPublisher({ connection, exchange: "", routingKey: queue, encode, signal });
    cleanup(() => sending.release());
    await sending.value.publish(1);
    await admitted.promise;
    await sending.value.publish(2);
    // An RPC on the channel provides a broker barrier, without sleeping.
    assert.equal((await channel.queueDeclare({ queue, passive: true })).messageCount, 1);
    assert.equal(native?.stats.acknowledged, 0);
    controller.abort();
    let released = false;
    const stop = Promise.resolve(handle.release()).then(() => {
      released = true;
    });
    await channel.queueDeclare({ queue, passive: true });
    assert.equal(released, false);
    release.resolve();
    await stop;
    assert.equal(invocations, 1);
    assert.equal(native?.stats.acknowledged, 1);
    const remaining = await channel.basicGet({ queue, noAck: true });
    assert.equal(remaining?.body.toString(), "2");
  },
);

test(
  "real broker: partial startup closes its native consumer while provided connection remains usable",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { connection, queue } = await broker(t);
    let native: Consumer | undefined;
    await assert.rejects(
      rabbitmqListener(
        {
          connection: { createConsumer: (options, handler) => (native = connection.createConsumer(options, handler)) },
          consumer: { queue, queueOptions: { durable: false }, qos: { prefetchCount: 1 } },
          decode,
          failurePolicy: () => "reject",
          onError: (error) => {
            throw error;
          },
        },
        {
          signal: new AbortController().signal,
          invoke: async () => success(),
        },
      ),
      /PRECONDITION_FAILED/,
    );
    assert.equal(native?.consumerTag, "");
    const channel = await connection.acquire();
    await channel.close();
  },
);

test(
  "real broker: native consumer recovers after broker cancellation without a second Flow binding",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { connection, channel, queue, cleanup } = await broker(t);
    let native: Consumer | undefined;
    const connectionView: RabbitConsumerConnection = {
      createConsumer: (options, handler) => (native = connection.createConsumer(options, handler)),
    };
    const observed = Promise.withResolvers<void>();
    const handle = await rabbitmqListener(
      {
        connection: connectionView,
        consumer: { queue, queueOptions: { durable: true }, qos: { prefetchCount: 1 } },
        decode,
        failurePolicy: () => "reject",
        onError: () => {
          /* Expected native broker cancellation. */
        },
      },
      {
        signal: new AbortController().signal,
        invoke: async () => {
          observed.resolve();
          return success();
        },
      },
    );
    cleanup(() => handle.release());
    assert.ok(native);
    // once(..., 'ready') normally rejects on 'error'; the cancellation error here is expected.
    const ready = new Promise<void>((resolve) => native!.once("ready", resolve));
    const cancelled = once(native, "error");
    await channel.queueDelete({ queue });
    await cancelled;
    await ready;
    const sending = await rabbitmqPublisher({ connection, exchange: "", routingKey: queue, encode, signal });
    cleanup(() => sending.release());
    await sending.value.publish(1);
    await observed.promise;
    await handle.release();
    assert.equal(native.stats.acknowledged, 1);
  },
);

test(
  "real broker: quorum redelivery supplies the one-based Flow attempt without a local delivery counter",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { connection, channel, queue, cleanup } = await broker(t);
    const quorum = `${queue}.quorum`;
    await channel.queueDeclare({ queue: quorum, durable: true, arguments: { "x-queue-type": "quorum" } });
    cleanup(() => connection.queueDelete({ queue: quorum }));
    const sending = await rabbitmqPublisher({ connection, exchange: "", routingKey: quorum, encode, signal });
    cleanup(() => sending.release());
    await sending.value.publish(1);
    const first = await channel.basicGet({ queue: quorum, noAck: false });
    assert.ok(first);
    channel.basicNack({ deliveryTag: first.deliveryTag, requeue: true });
    await channel.queueDeclare({ queue: quorum, passive: true });
    const observed = Promise.withResolvers<number | undefined>();
    const handle = await rabbitmqListener(
      {
        connection,
        consumer: {
          queue: quorum,
          queueOptions: { durable: true, arguments: { "x-queue-type": "quorum" } },
          qos: { prefetchCount: 1 },
        },
        decode,
        failurePolicy: () => "reject",
        onError: (error) => {
          observed.reject(error);
        },
      },
      {
        signal: new AbortController().signal,
        invoke: async (request) => {
          observed.resolve(request.trigger?.attempt);
          return success();
        },
      },
    );
    cleanup(() => handle.release());
    assert.equal(await observed.promise, 2);
  },
);
