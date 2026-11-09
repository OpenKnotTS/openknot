import { rabbitmqListener } from "../../../rabbitmq/src/listener/listener.ts";
import { rabbitmqPublisher } from "../../../rabbitmq/src/publisher/publisher.ts";
import { openTelemetryTracing } from "../src/index.ts";
import { provideOpenTelemetry } from "../src/wire.ts";
import { remote, remoteTraceId, telemetry } from "./support.ts";
import { success } from "@openknot-ts/behavior";
import { command, expose, listener, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import type { RabbitConsumerConnection } from "@openknot-ts/rabbitmq";
import type { RabbitEnvelope, RabbitPublisherConnection } from "@openknot-ts/rabbitmq";
import type { PropagationCarrier } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { composeModule, defineApplication, override, plug, providePlugs, runApplication } from "@openknot-ts/wire";
import { propagation, SpanKind } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator } from "@opentelemetry/core";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// These publishers declare no topology, so nothing calls the connection's declarations.
const undeclared = async (): Promise<never> => {
  throw new Error("No topology is declared");
};
const declarations = {
  queueDeclare: undeclared,
  exchangeDeclare: undeclared,
  queueBind: undeclared,
  exchangeBind: undeclared,
};
const signal = new AbortController().signal;

test("container tracing automatically instruments AMQP across separate SDKs and real child processes", async () => {
  const producer = telemetry();
  const consumer = telemetry({ consumerParent: "parent" });
  let envelope: RabbitEnvelope | undefined;
  const native = Object.assign(new EventEmitter(), {
    async send(value: RabbitEnvelope | string) {
      assert.ok(typeof value !== "string");
      envelope = value;
    },
    async close() {},
  });
  const connection: RabbitPublisherConnection = { ...declarations, createPublisher: () => native };
  const managed = await rabbitmqPublisher<number>({
    connection,
    exchange: "roles",
    routingKey: "created",
    encode: (value) => Buffer.from(String(value)),
    properties: () => ({ correlationId: "native-conversation", headers: { custom: "native" } }),
    signal,
  });
  const output = publisher<number>();
  const work = command({
    requirements: { output },
    run: async (_, ctx) => {
      await ctx.output.publish(7);
      return success();
    },
  });
  const api = expose({ handler: work });
  const binding = plug({ port: output, bind: () => managed.value.publish });
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([api]),
        composeModule({ providers: { binding } }),
        provideOpenTelemetry({
          factory: () => ({ tracer: producer.tracer, context: producer.context, propagator: producer.propagator }),
        }),
      ],
    }),
  );
  const incoming = listener<number>()({ run: (value, ctx) => success({ value, actorId: ctx.actor }) });
  const receiving = await runApplication(
    defineApplication({
      modules: [
        provideFlow([incoming]),
        provideOpenTelemetry({
          factory: () => ({
            tracer: consumer.tracer,
            context: consumer.context,
            propagator: consumer.propagator,
            consumerParent: "parent",
          }),
        }),
      ],
    }),
  );
  let deliver: Parameters<RabbitConsumerConnection["createConsumer"]>[1] | undefined;
  const consumerConnection: RabbitConsumerConnection = {
    createConsumer: (_options, handler) => {
      deliver = handler;
      const native = Object.assign(new EventEmitter(), {
        start() {
          queueMicrotask(() => native.emit("ready"));
        },
        async close() {},
      });
      return native;
    },
  };
  const input = await rabbitmqListener(
    {
      connection: consumerConnection,
      consumer: { queue: "logs", qos: { prefetchCount: 1 } },
      decode: (message) => Number(String(message.body)),
      failurePolicy: () => "reject",
      onError: (error) => {
        throw error;
      },
    },
    {
      invoke: receiving.resolve(incoming),
      signal: new AbortController().signal,
    },
  );
  try {
    await app.resolve(api)({ input: undefined, propagation: remote, actor: "alice" });
    assert.ok(envelope);
    assert.equal(envelope.headers?.custom, "native");
    assert.equal(envelope.headers?.["x-openknot-actor-id"], undefined);
    assert.equal(envelope.correlationId, "native-conversation");
    const send = producer.exporter.getFinishedSpans().find((span) => span.kind === SpanKind.PRODUCER)!;
    assert.equal(send.name, "send roles:created");
    assert.equal(send.attributes["messaging.system"], "rabbitmq");
    assert.equal(send.attributes["messaging.message.conversation_id"], "native-conversation");
    assert.equal(String(envelope.headers?.traceparent).split("-")[2], send.spanContext().spanId);
    assert.equal(
      await deliver!(
        {
          ...envelope,
          exchange: "roles",
          routingKey: "created",
          consumerTag: "test",
          body: Buffer.from("7"),
          deliveryTag: 1,
          redelivered: false,
        },
        async () => undefined,
      ),
      0,
    );
    const received = consumer.exporter.getFinishedSpans().find((span) => span.kind === SpanKind.CONSUMER)!;
    assert.equal(received.spanContext().traceId, remoteTraceId);
    assert.equal(received.parentSpanContext?.spanId, send.spanContext().spanId);
    assert.equal(received.attributes["messaging.destination.name"], "roles:created:logs");
    assert.equal(received.attributes["messaging.message.id"], envelope.messageId);
    assert.equal(received.attributes["messaging.message.conversation_id"], "native-conversation");
    assert.ok(!("signal" in (envelope.headers ?? {})));
    const carrier = {
      traceparent: String(envelope.headers?.traceparent),
      tracestate: String(envelope.headers?.tracestate),
    };
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./process.ts", import.meta.url)), JSON.stringify(carrier)],
      { env: environment },
    );
    assert.ok(stdout.length > 0, `Child returned no spans: ${stderr}`);
    const spans = JSON.parse(stdout) as { name: string; context: { traceId: string }; parent?: { spanId: string } }[];
    const child = spans.find((s) => s.name === "openknot.listener")!;
    assert.equal(child.context.traceId, remoteTraceId);
    assert.equal(child.parent?.spanId, send.spanContext().spanId);
  } finally {
    await input.release();
    await receiving.stop();
    await app.stop();
    await managed.release();
    await producer.release();
    await consumer.release();
  }
});

test("one native publisher serves traced and untraced containers without sharing their SDK configuration", async () => {
  const first = telemetry(),
    second = telemetry();
  const sent = new Map<number, RabbitEnvelope>();
  const connection: RabbitPublisherConnection = {
    ...declarations,
    createPublisher: () =>
      Object.assign(new EventEmitter(), {
        async send(envelope: RabbitEnvelope | string, body: unknown) {
          assert.ok(typeof envelope !== "string");
          sent.set(Number(String(body)), envelope);
        },
        async close() {},
      }),
  };
  const managed = await rabbitmqPublisher({
    connection,
    exchange: "roles",
    routingKey: "created",
    encode: (value: number) => Buffer.from(String(value)),
    signal,
  });
  const output = publisher<number>();
  const work = command<number>()({
    requirements: { output },
    run: async (value, ctx) => {
      await ctx.output.publish(value);
      return success();
    },
  });
  const api = expose({ handler: work });
  const binding = plug({ port: output, bind: () => managed.value.publish });
  const definition = defineApplication({
    modules: [provideFlow([api]), composeModule({ providers: { binding } })],
  });
  const one = await runApplication(definition, { overrides: [override(trace, first.tracing)] });
  const two = await runApplication(definition, { overrides: [override(trace, second.tracing)] });
  const plain = await runApplication(definition);
  try {
    await Promise.all([
      one.resolve(api)({ input: 1 }),
      two.resolve(api)({ input: 2 }),
      plain.resolve(api)({ input: 3 }),
    ]);
    const firstSend = first.exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.PRODUCER);
    const secondSend = second.exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.PRODUCER);
    assert.equal(firstSend.length, 1);
    assert.equal(secondSend.length, 1);
    assert.equal(String(sent.get(1)?.headers?.traceparent).split("-")[2], firstSend[0]?.spanContext().spanId);
    assert.equal(String(sent.get(2)?.headers?.traceparent).split("-")[2], secondSend[0]?.spanContext().spanId);
    assert.notEqual(firstSend[0]?.spanContext().traceId, secondSend[0]?.spanContext().traceId);
    assert.equal(sent.get(3)?.headers?.traceparent, undefined);
    assert.equal(sent.size, 3);
  } finally {
    await Promise.all([one.stop(), two.stop(), plain.stop()]);
    await managed.release();
    await Promise.all([first.release(), second.release()]);
  }
});

test("native listener bindings select the container propagator's baggage fields automatically", async () => {
  const otel = telemetry();
  const tracing = openTelemetryTracing({
    tracer: otel.tracer,
    context: otel.context,
    propagator: new CompositePropagator({ propagators: [otel.propagator, new W3CBaggagePropagator()] }),
  });
  let deliver: Parameters<RabbitConsumerConnection["createConsumer"]>[1] | undefined;
  let tenant: string | undefined;
  const connection: RabbitConsumerConnection = {
    createConsumer: (_options, handler) => {
      deliver = handler;
      const native = Object.assign(new EventEmitter(), {
        start() {
          queueMicrotask(() => native.emit("ready"));
        },
        async close() {},
      });
      return native;
    },
  };
  const incoming = listener<number>()({
    run: () => {
      tenant = propagation.getBaggage(otel.context.active())?.getEntry("tenant")?.value;
      return success();
    },
  });
  const binding = plug({
    port: incoming,
    bind: (context) =>
      rabbitmqListener(
        {
          connection,
          consumer: { queue: "roles", qos: { prefetchCount: 1 } },
          decode: () => 1,
          failurePolicy: () => "reject",
          onError: (error) => {
            throw error;
          },
        },
        context,
      ),
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([binding])] }), {
    overrides: [override(trace, tracing)],
  });
  try {
    assert.ok(deliver);
    assert.equal(
      await deliver(
        {
          exchange: "roles",
          routingKey: "created",
          consumerTag: "test",
          deliveryTag: 1,
          redelivered: false,
          body: Buffer.from("1"),
          headers: { ...remote, baggage: "tenant=blue", authorization: "must-stay-outside-propagation" },
        },
        async () => undefined,
      ),
      0,
    );
    assert.equal(tenant, "blue");
    const consumed = otel.exporter.getFinishedSpans().find((span) => span.kind === SpanKind.CONSUMER);
    assert.equal(consumed?.links[0]?.context.traceId, remoteTraceId);
  } finally {
    await app.stop();
    await otel.release();
  }
});

test("default consumer links support fan-out with one independent execution per delivery", async () => {
  const otel = telemetry();
  let carrier: PropagationCarrier | undefined;
  await otel.tracing.run({ name: "send", kind: "producer" }, async () => {
    carrier = otel.tracing.capture();
  });
  const incoming = listener<number>()({ run: (input) => success(input) });
  const app = await runApplication(defineApplication({ modules: [provideFlow([incoming])] }), {
    overrides: [override(trace, otel.tracing)],
  });
  try {
    await Promise.all([1, 2].map((input) => app.resolve(incoming)({ input, propagation: carrier })));
    const consumers = otel.exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.CONSUMER);
    assert.equal(consumers.length, 2);
    assert.notEqual(consumers[0]?.spanContext().traceId, consumers[1]?.spanContext().traceId);
    assert.equal(consumers[0]?.links[0]?.context.spanId, consumers[1]?.links[0]?.context.spanId);
  } finally {
    await app.stop();
    await otel.release();
  }
});
