import { rabbitTopology } from "../src/index.ts";
import { rabbit } from "../src/setup/connection.ts";
import { observer } from "./broker.ts";
import { brokerProxy } from "./proxy.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { success } from "@openknot-ts/behavior";
import { command, expose, listener, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection } from "rabbitmq-client";

/** An application whose exposure publishes its input to the queue that a listener's command running `run` consumes. */
async function publishingApplication(
  queue: string,
  env: Readonly<Record<string, string>>,
  run: (input: number) => Promise<Outcome<void, never>>,
) {
  const received = listener({ handler: command<number>()({ run }) });
  const events = publisher<number>();
  const send = expose({
    handler: command<number>()({
      requirements: { events },
      async run(input, ctx) {
        await ctx.events.publish(input);
        return success();
      },
    }),
  });
  const { rabbitListener, rabbitPublisher } = rabbitTopology({
    exchanges: [],
    queues: [{ queue }],
    routes: [{ exchange: "", routingKey: queue }],
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([received, send, events]),
        providePlugs([rabbitListener(received), rabbitPublisher(events)]),
      ],
    }),
    { env, stopOn: [] },
  );
  return { app, send };
}

test(
  "managed setup shares its connection and drains an admitted command before closing it",
  { timeout: 15_000 },
  async (t) => {
    const { connection, queue, cleanup, env } = await observer(t);
    const entered = Promise.withResolvers<number>();
    const finish = Promise.withResolvers<void>();
    const completed: number[] = [];
    const { app, send } = await publishingApplication(queue, env, async (input) => {
      entered.resolve(input);
      await finish.promise;
      completed.push(input);
      return success();
    });
    cleanup(() => connection.queueDelete({ queue }));
    cleanup(async () => {
      finish.resolve();
      await app.stop();
    });
    const native = await app.withScope((scope) => scope.resolve(rabbit));
    assert.notEqual(native, connection);
    await app.withScope((scope) => scope.resolve(send)({ input: 42 }));
    assert.equal(await entered.promise, 42);
    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert.equal(stopped, false);
    assert.equal(native.ready, true);
    finish.resolve();
    await stopping;
    assert.deepEqual(completed, [42]);
    assert.equal(native.ready, false);
  },
);

test(
  "shutdown drains an admitted delivery and returns one its stopped input did not admit to the queue",
  { timeout: 15_000 },
  async (t) => {
    const { connection, queue, cleanup, env } = await observer(t);
    // Intake stops when the native consumer starts closing.
    const closing = Promise.withResolvers<void>();
    const createConsumer = Connection.prototype.createConsumer;
    t.mock.method(
      Connection.prototype,
      "createConsumer",
      function (this: Connection, ...args: Parameters<typeof createConsumer>) {
        const consumer = createConsumer.apply(this, args);
        const close = consumer.close.bind(consumer);
        consumer.close = () => {
          closing.resolve();
          return close();
        };
        return consumer;
      },
    );
    const entered = Promise.withResolvers<void>();
    const decoding = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const completed: number[] = [];
    const received = listener<number>()({
      async run(input) {
        if (input === 1) {
          entered.resolve();
          await finish.promise;
        }
        completed.push(input);
        return success();
      },
    });
    // The second delivery stays in decoding until intake has stopped, so it reaches the input afterwards.
    const schema: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate(value) {
          if (value === 2) {
            decoding.resolve();
            await closing.promise;
          }
          return { value: value as number };
        },
      },
    };
    const { rabbitListener } = rabbitTopology({ exchanges: [], queues: [{ queue }], routes: [] });
    const app = await runApplication(
      defineApplication({
        modules: [provideFlow([received]), providePlugs([rabbitListener({ queue, schema }, received)])],
      }),
      { env },
    );
    cleanup(() => connection.queueDelete({ queue }));
    cleanup(async () => {
      finish.resolve();
      await app.stop();
    });
    const channel = await connection.acquire();
    cleanup(() => channel.close());
    await channel.basicPublish({ routingKey: queue }, Buffer.from("1"));
    await channel.basicPublish({ routingKey: queue }, Buffer.from("2"));
    await Promise.all([entered.promise, decoding.promise]);
    const stopping = app.stop();
    await closing.promise;
    finish.resolve();
    await stopping;
    assert.deepEqual(completed, [1]);
    const { messageCount } = await channel.queueDeclare({ queue, passive: true });
    assert.equal(messageCount, 1);
    const left = await channel.basicGet({ queue, noAck: true });
    assert.equal(String(left?.body), "2");
  },
);

test("a stopped application leaves no connection, channel or timer of its own", { timeout: 15_000 }, async (t) => {
  const { connection, queue, cleanup, env } = await observer(t);
  // Closed handles leave libuv in the close phase that follows the current turn of the event loop.
  const resources = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return process.getActiveResourcesInfo().sort();
  };
  const before = await resources();
  const delivered = Promise.withResolvers<void>();
  let count = 0;
  const { app, send } = await publishingApplication(queue, env, async () => {
    if (++count === 20) {
      delivered.resolve();
    }
    return success();
  });
  cleanup(() => connection.queueDelete({ queue }));
  cleanup(() => app.stop());
  const invoke = app.resolve(send);
  await Promise.all(Array.from({ length: 20 }, (_, input) => invoke({ input })));
  await delivered.promise;
  await app.stop();
  assert.deepEqual(await resources(), before);
});

test("separate applications keep managed connection and defaults isolated", { timeout: 15_000 }, async (t) => {
  const { connection, queue, cleanup, env } = await observer(t);
  const received = listener({ run: () => success() });
  const { rabbitListener } = rabbitTopology({ exchanges: [], queues: [{ queue }], routes: [] });
  const definition = defineApplication({
    modules: [provideFlow([received]), providePlugs([rabbitListener(received)])],
  });
  const first = await runApplication(definition, { env });
  cleanup(() => connection.queueDelete({ queue }));
  cleanup(() => first.stop());
  const second = await runApplication(definition, { env });
  cleanup(() => second.stop());
  const a = await first.withScope((scope) => scope.resolve(rabbit));
  const b = await second.withScope((scope) => scope.resolve(rabbit));
  assert.notEqual(a, b);
  await first.stop();
  assert.equal(a.ready, false);
  assert.equal(b.ready, true);
});

test(
  "a refused managed consumer declaration rolls back and closes its shared connection",
  { timeout: 15_000 },
  async (t) => {
    const { connection, queue, cleanup, env } = await observer(t);
    await connection.queueDeclare({ queue, durable: true, autoDelete: true });
    cleanup(() => connection.queueDelete({ queue }));
    const acquire = Connection.prototype.acquire;
    let acquired: { ready(): boolean; destroy(): void } | undefined;
    t.mock.method(Connection.prototype, "acquire", function (this: Connection, ...args: Parameters<typeof acquire>) {
      acquired = { ready: () => this.ready, destroy: () => this.unsafeDestroy() };
      return acquire.apply(this, args);
    });
    cleanup(() => acquired?.destroy());
    const received = listener({ run: () => success() });
    const { rabbitListener } = rabbitTopology({ exchanges: [], queues: [{ queue }], routes: [] });
    const application = defineApplication({
      modules: [provideFlow([received]), providePlugs([rabbitListener({ queue }, received)])],
    });
    await assert.rejects(runApplication(application, { env }), /PRECONDITION_FAILED/);
    assert.ok(acquired);
    assert.equal(acquired.ready(), false);
  },
);

test(
  "topology and bindings recover after real AMQP socket loss without duplicating the Flow binding",
  { timeout: 20_000 },
  async (t) => {
    const { queue, cleanup, env } = await observer(t);
    const proxy = await brokerProxy(t, env.RABBITMQ_URL);
    const receivedValues: number[] = [];
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const received = listener<number>()({
      run(input) {
        receivedValues.push(input);
        (input === 1 ? first : second).resolve();
        return success();
      },
    });
    const events = publisher<number>();
    const send = expose({
      handler: command<number>()({
        requirements: { events },
        async run(input, ctx) {
          await ctx.events.publish(input);
          return success();
        },
      }),
    });
    const exchange = `${queue}.recovered`;
    const { rabbitListener, rabbitPublisher } = rabbitTopology({
      exchanges: [{ exchange, type: "topic", durable: false, autoDelete: true }],
      queues: [{ queue, durable: false, exclusive: true, autoDelete: true }],
      routes: [{ exchange, routingKey: "event.created" }],
      queueBindings: [{ exchange, queue, routingKey: "event.*" }],
    });
    const app = await runApplication(
      defineApplication({
        modules: [
          provideFlow([received, send, events]),
          providePlugs([rabbitListener(received), rabbitPublisher(events)]),
        ],
      }),
      { env: { ...env, RABBITMQ_URL: proxy.url } },
    );
    cleanup(() => app.stop());
    await app.withScope((scope) => scope.resolve(send)({ input: 1 }));
    await first.promise;
    const native = await app.withScope((scope) => scope.resolve(rabbit));
    const reconnected = new Promise<void>((resolve) => native.once("connection", resolve));
    proxy.disconnect();
    await reconnected;
    await app.withScope((scope) => scope.resolve(send)({ input: 2 }));
    await second.promise;
    assert.deepEqual(receivedValues, [1, 2]);
  },
);
