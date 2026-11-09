import type { RabbitEnvelope } from "../src/index.ts";
import { rabbitmqPublisher } from "../src/publisher/publisher.ts";
import { fakePublisherConnection } from "./publisher-fakes.ts";
import type { Tracing } from "@openknot-ts/tracing";
import assert from "node:assert/strict";
import { test } from "node:test";

const encode = (message: { id: number }) => Buffer.from(JSON.stringify(message));
const signal = new AbortController().signal;

test("fresh injection clears stale propagation fields without mutating native headers and preserves caller-owned native headers", async () => {
  const connection = fakePublisherConnection();
  let sent: RabbitEnvelope | undefined;
  connection.publisher.send = async (envelope) => {
    assert.ok(typeof envelope !== "string");
    sent = envelope;
  };
  const headers = Object.freeze({
    traceparent: "stale",
    TraceState: "stale=state",
    custom: "native",
    "x-openknot-actor-id": "raw",
  });
  const tracing: Tracing = {
    propagationFields: ["traceparent", "tracestate"],
    run: async (_span, work) => work(),
    capture: () => ({ traceparent: "fresh" }),
    bind: (work) => work,
  };
  const managed = await rabbitmqPublisher({
    connection,
    exchange: "roles",
    routingKey: "changed",
    encode,
    properties: () => ({ headers }),
    signal,
  });
  try {
    await managed.value.publish({ id: 1 }, { tracing });
    assert.equal(sent?.headers?.traceparent, "fresh");
    assert.equal(sent?.headers?.TraceState, undefined);
    assert.equal(sent?.headers?.tracestate, undefined);
    assert.equal(sent?.headers?.custom, "native");
    assert.equal(sent?.headers?.["x-openknot-actor-id"], "raw");
    assert.equal(headers.traceparent, "stale");
    assert.equal(headers.TraceState, "stale=state");
  } finally {
    await managed.release();
  }
});

test("publication awaits the native confirmation and preserves payload, routing, properties and trace propagation", async () => {
  const connection = fakePublisherConnection();
  const headers = { custom: "native" };
  const managed = await rabbitmqPublisher({
    connection,
    exchange: "roles",
    routingKey: (message: { id: number }) => `role.${message.id}`,
    encode,
    properties: () => ({
      contentType: "application/octet-stream",
      durable: true,
      messageId: "domain-id",
      correlationId: "native-conversation",
      headers,
    }),
    topology: { exchanges: [{ exchange: "roles", type: "topic" }] },
    signal,
  });
  const message = Object.freeze({ id: 7 });
  let settled = false;
  const published = managed.value
    .publish(message, {
      propagation: Object.freeze({ traceparent: "opaque-standard-trace", tracestate: "vendor=value" }),
    })
    .then(() => {
      settled = true;
    });
  await Promise.resolve();
  assert.equal(settled, false);
  const sent = connection.publisher.sent[0]!;
  assert.deepEqual(JSON.parse(sent.body.toString()), message);
  assert.equal(sent.envelope.exchange, "roles");
  assert.equal(sent.envelope.routingKey, "role.7");
  assert.equal(sent.envelope.messageId, "domain-id");
  assert.equal(sent.envelope.durable, true);
  assert.equal(sent.envelope.correlationId, "native-conversation");
  assert.equal(sent.envelope.headers?.["x-openknot-actor-id"], undefined);
  assert.equal(sent.envelope.headers?.traceparent, "opaque-standard-trace");
  assert.equal(sent.envelope.headers?.tracestate, "vendor=value");
  assert.deepEqual(headers, { custom: "native" });
  assert.equal(connection.options?.confirm, true);
  assert.equal(connection.options?.maxAttempts, 1);
  sent.confirm.resolve();
  await published;
  await managed.release();
  assert.equal(connection.publisher.closed, 1);
});

test("the topology is declared in its native order before the publisher exists; a refused or cancelled declaration fails initialization", async () => {
  const topology = {
    queues: [{ queue: "audit" }],
    exchanges: [{ exchange: "roles", type: "topic", arguments: { "alternate-exchange": "unrouted" } }],
    queueBindings: [{ queue: "audit", exchange: "roles", routingKey: "#" }],
    exchangeBindings: [{ source: "roles", destination: "mirror" }],
  };
  const options = { exchange: "roles", routingKey: "changed", encode, topology };
  const connection = fakePublisherConnection();
  const managed = await rabbitmqPublisher({ ...options, connection, signal });
  assert.deepEqual(connection.declared, ["queue audit", "exchange roles", "bind roles → audit", "bind roles → mirror"]);
  // The native publisher declares the same topology again on every channel it opens.
  assert.deepEqual(connection.options, { ...topology, confirm: true, maxAttempts: 1 });
  await managed.release();

  const refusing = fakePublisherConnection();
  refusing.declaration = Promise.reject(new Error("PRECONDITION_FAILED"));
  await assert.rejects(rabbitmqPublisher({ ...options, connection: refusing, signal }), /PRECONDITION_FAILED/);
  assert.equal(refusing.options, undefined);

  // An unreachable broker holds the declaration; cancelling the startup stops waiting for it.
  const unreachable = fakePublisherConnection();
  unreachable.declaration = new Promise(() => {});
  const startup = new AbortController();
  const initializing = rabbitmqPublisher({ ...options, connection: unreachable, signal: startup.signal });
  startup.abort(new Error("startup cancelled"));
  await assert.rejects(initializing, /startup cancelled/);
  assert.deepEqual(unreachable.declared, ["queue audit"]);
  assert.equal(unreachable.options, undefined);
});

test("confirm and codec failures propagate, pre-send cancellation sends nothing, and release waits for in-flight sends", async () => {
  const connection = fakePublisherConnection();
  const managed = await rabbitmqPublisher({ connection, exchange: "", routingKey: "q", encode, signal });
  const cancelled = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(managed.value.publish({ id: 0 }, { signal: cancelled }), /cancelled/);
  assert.equal(connection.publisher.sent.length, 0);
  const failed = managed.value.publish({ id: 1 });
  const rejected = assert.rejects(failed, /nack/);
  connection.publisher.sent[0]!.confirm.reject(new Error("nack"));
  await rejected;
  const active = managed.value.publish({ id: 2 });
  const stopped = managed.release();
  await Promise.resolve();
  assert.equal(connection.publisher.closed, 0);
  await assert.rejects(managed.value.publish({ id: 3 }), /closing/);
  connection.publisher.sent[1]!.confirm.resolve();
  await Promise.all([active, stopped, managed.release()]);
  assert.equal(connection.publisher.closed, 1);

  const invalid = await rabbitmqPublisher({
    connection,
    exchange: "",
    routingKey: "q",
    encode: () => {
      throw new Error("codec");
    },
    signal,
  });
  await assert.rejects(invalid.value.publish(undefined), /codec/);
  await invalid.release();
});

test("in-flight publication still waits for a definitive confirm after cancellation", async () => {
  const connection = fakePublisherConnection();
  const managed = await rabbitmqPublisher({ connection, exchange: "", routingKey: "q", encode, signal });
  const controller = new AbortController();
  let complete = false;
  const published = managed.value.publish({ id: 1 }, { signal: controller.signal }).then(() => {
    complete = true;
  });
  controller.abort();
  await Promise.resolve();
  assert.equal(complete, false);
  connection.publisher.sent[0]!.confirm.resolve();
  await published;
  await managed.release();
});
