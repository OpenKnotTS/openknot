import { rabbitClient, rabbitTopology } from "../src/index.ts";
import { observer } from "./broker.ts";
import { success } from "@openknot-ts/behavior";
import { command, expose, listener, PostCommitError, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { config, defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Connection } from "rabbitmq-client";
import { z } from "zod";

test(
  "independent native connections share topology bindings without mandatory default config",
  { timeout: 15_000 },
  async (t) => {
    const { queue, cleanup, env, connection: observerConnection } = await observer(t);
    const settings = config({ BUS_URL: z.url() });
    const client = rabbitClient({
      requirements: { settings },
      create: ({ settings }) =>
        new Connection({
          url: settings.BUS_URL,
          connectionName: "openknot-native-options",
          maxChannels: 16,
          frameMax: 16_384,
          noDelay: false,
          retryLow: 15,
          retryHigh: 30,
        }),
    });
    const { rabbitPublisher, rabbitNativeConnection } = rabbitTopology({
      connection: client,
      exchanges: [],
      queues: [{ queue }],
      routes: [{ exchange: "", routingKey: queue }],
    });
    const output = publisher<{ readonly native: boolean }>();
    const emit = expose({
      handler: command({
        requirements: { output },
        run: async (_, ctx) => {
          await ctx.output.publish({ native: true });
          return success();
        },
      }),
    });
    const app = await runApplication(
      defineApplication({
        modules: [
          provideFlow([emit]),
          providePlugs([
            rabbitPublisher(
              {
                exchange: "",
                routingKey: queue,
                publisher: { maxAttempts: 2 },
                properties: (message) => ({
                  headers: { custom: "native", payloadFlag: message.native },
                  expiration: "30000",
                }),
              },
              output,
            ),
          ]),
        ],
      }),
      { env: { BUS_URL: env.RABBITMQ_URL, RABBITMQ_URL: "unused" }, stopOn: [] },
    );
    cleanup(() => observerConnection.queueDelete({ queue }));
    cleanup(() => app.stop());
    const raw = app.resolve(rabbitNativeConnection);
    assert.ok(raw instanceof Connection && raw.ready);
    await app.withScope((scope) => scope.resolve(emit)({}));
    const delivery = await raw.basicGet({ queue, noAck: true });
    assert.ok(delivery);
    assert.deepEqual(delivery.body, { native: true });
    assert.equal(delivery.headers?.custom, "native");
    assert.equal(delivery.headers?.payloadFlag, true);
  },
);

test(
  "typed topology routes through its exchange and publisher confirms reject an unbound declared route",
  { timeout: 15_000 },
  async (t) => {
    const { connection, queue, cleanup, env } = await observer(t);
    const seen = Promise.withResolvers<number>();
    const returned: string[] = [];
    const received = listener<number>()({
      run: (input) => {
        seen.resolve(input);
        return success();
      },
    });
    const events = publisher<number>();
    const missing = publisher<number>();
    const send = expose({
      handler: command<number>()({
        requirements: { events, missing },
        async run(input, ctx) {
          await (input === 1 ? ctx.events : ctx.missing).publish(input);
          return success();
        },
      }),
    });
    const exchange = `${queue}.events`;
    const { rabbitListener, rabbitPublisher } = rabbitTopology({
      exchanges: [{ exchange, type: "topic" }],
      queues: [{ queue }],
      routes: [
        { exchange, routingKey: "role.created" },
        { exchange, routingKey: "unrouted.created" },
      ],
      queueBindings: [{ exchange, queue, routingKey: "role.*" }],
    });
    const app = await runApplication(
      defineApplication({
        modules: [
          provideFlow([received, send, events, missing]),
          providePlugs([
            rabbitListener({ queue }, received),
            rabbitPublisher({ exchange, routingKey: "role.created" }, events),
            rabbitPublisher(
              {
                exchange,
                routingKey: "unrouted.created",
                publisher: { maxAttempts: 1 },
                configure: (publisher) => {
                  publisher.on("basic.return", (message) => {
                    returned.push(message.routingKey);
                  });
                },
              },
              missing,
            ),
          ]),
        ],
      }),
      { env },
    );
    cleanup(() => connection.exchangeDelete({ exchange }));
    cleanup(() => connection.queueDelete({ queue }));
    cleanup(() => app.stop());
    await app.withScope((scope) => scope.resolve(send)({ input: 1 }));
    assert.equal(await seen.promise, 1);
    await assert.rejects(
      app.withScope((scope) => scope.resolve(send)({ input: 2 })),
      PostCommitError.is,
    );
    assert.deepEqual(returned, ["unrouted.created"]);
  },
);

test(
  "managed JSON and asynchronous schema failures are reported and dead-lettered before Flow runs",
  { timeout: 15_000 },
  async (t) => {
    const { connection, queue, cleanup, env } = await observer(t);
    const deadQueue = `${queue}.failed`;
    await connection.queueDeclare({ queue: deadQueue, durable: true });
    cleanup(() => connection.queueDelete({ queue: deadQueue }));
    const reports: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      reports.push(args);
    });
    const rejected = Promise.withResolvers<string>();
    const handled = Promise.withResolvers<string>();
    const bodies: string[] = [];
    const deadLetters = connection.createConsumer(
      { queue: deadQueue, queueOptions: { durable: true }, lazy: true, noAck: true },
      async (message) => {
        bodies.push(Buffer.isBuffer(message.body) ? message.body.toString("utf8") : String(message.body));
        if (bodies.length === 2) {
          rejected.resolve("dead-lettered");
        }
      },
    );
    cleanup(() => deadLetters.close());
    const ready = once(deadLetters, "ready");
    deadLetters.start();
    await ready;
    const received = listener<number>()({
      run: () => {
        handled.resolve("handler ran");
        return success();
      },
    });
    const { rabbitListener } = rabbitTopology({
      exchanges: [],
      queues: [
        {
          queue,
          arguments: { "x-dead-letter-exchange": "", "x-dead-letter-routing-key": deadQueue },
        },
      ],
      routes: [],
    });
    const app = await runApplication(
      defineApplication({
        modules: [
          provideFlow([received]),
          providePlugs([
            rabbitListener(
              {
                queue,
                schema: {
                  "~standard": {
                    version: 1,
                    vendor: "test-positive-number",
                    validate: async (value) =>
                      typeof value === "number" && value > 0
                        ? { value }
                        : { issues: [{ message: "Expected a positive number" }] },
                  },
                },
              },
              received,
            ),
          ]),
        ],
      }),
      { env },
    );
    cleanup(() => connection.queueDelete({ queue }));
    cleanup(() => app.stop());
    const sender = connection.createPublisher({ confirm: true });
    cleanup(() => sender.close());
    await sender.send({ routingKey: queue, contentType: "application/octet-stream" }, Buffer.from("not-json"));
    await sender.send({ routingKey: queue, contentType: "application/json" }, Buffer.from("-1"));
    assert.equal(await Promise.race([rejected.promise, handled.promise]), "dead-lettered");
    assert.deepEqual(bodies.sort(), ["-1", "not-json"]);
    assert.equal(
      reports.filter(
        ([, attributes]) =>
          (attributes as Readonly<Record<string, unknown>> | undefined)?.["messaging.destination.name"] === queue,
      ).length,
      2,
    );
  },
);

test(
  "publisher-only selection registers its topology without a listener or setup module",
  { timeout: 15_000 },
  async (t) => {
    const { connection, queue, cleanup, env } = await observer(t);
    const events = publisher<{ readonly value: number }>();
    const send = expose({
      handler: command({
        requirements: { events },
        async run(_, ctx) {
          await ctx.events.publish({ value: 7 });
          return success();
        },
      }),
    });
    const { rabbitPublisher } = rabbitTopology({
      exchanges: [],
      queues: [{ queue }],
      routes: [{ exchange: "", routingKey: queue }],
    });
    const app = await runApplication(
      defineApplication({
        modules: [provideFlow([send, events]), providePlugs([rabbitPublisher(events)])],
      }),
      { env },
    );
    cleanup(() => connection.queueDelete({ queue }));
    cleanup(() => app.stop());
    await app.withScope((scope) => scope.resolve(send)({}));
    const message = await connection.basicGet({ queue, noAck: true });
    assert.ok(message);
    assert.deepEqual(message.body, { value: 7 });
    assert.equal(message.durable, true);
  },
);
