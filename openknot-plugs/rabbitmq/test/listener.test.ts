import { rabbitmqListener } from "../src/listener/listener.ts";
import type { RabbitFailureKind, RabbitListenerOptions } from "../src/listener/listener.ts";
import { fakeConsumerConnection } from "./consumer-fakes.ts";
import type { FakeConsumerConnection } from "./consumer-fakes.ts";
import { InputCancelledError, InputUnavailableError, PostCommitError } from "@openknot-ts/flow";
import type { ListenerRequest } from "@openknot-ts/flow";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConsumerProps } from "rabbitmq-client";

function options(connection: FakeConsumerConnection): RabbitListenerOptions<number> {
  return {
    connection,
    consumer: { queue: "roles", qos: { prefetchCount: 4 }, concurrency: 2 },
    decode: ({ body }) => Number((body as Buffer).toString()),
    failurePolicy: () => "reject",
    onError: (error) => {
      throw error;
    },
  };
}

function context(): Parameters<typeof rabbitmqListener<number>>[1] {
  return { invoke: async () => undefined, signal: new AbortController().signal };
}

test("listener forwards decoded input, metadata and real attempts; acknowledgment waits for the entire Flow outcome", async () => {
  const connection = fakeConsumerConnection();
  const finished = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let request: ListenerRequest<number> | undefined;
  const handle = await rabbitmqListener(
    {
      ...options(connection),
    },
    {
      ...context(),
      invoke: async (value) => {
        request = value;
        entered.resolve();
        return finished.promise;
      },
    },
  );
  const consumer = connection.consumer!;
  const work = consumer.deliver({
    messageId: "message",
    correlationId: "native-conversation",
    redelivered: true,
    headers: {
      "x-openknot-actor-id": "actor",
      "x-delivery-count": 2,
      traceparent: "opaque-standard-trace",
      tracestate: "vendor=value",
      authorization: "not-propagated",
    },
  });
  await entered.promise;
  assert.equal(request?.input, 1);
  assert.equal(request?.actor, undefined);
  assert.deepEqual(request?.trigger, { messageId: "message", attempt: 3 });
  assert.deepEqual(request?.propagation, { traceparent: "opaque-standard-trace", tracestate: "vendor=value" });
  assert.equal(request?.traceAttributes?.["messaging.destination.name"], "events:changed:roles");
  assert.equal(request?.traceAttributes?.["messaging.operation.type"], "process");
  assert.equal(request?.traceAttributes?.["messaging.message.conversation_id"], "native-conversation");
  assert.equal(request?.signal, undefined);
  assert.deepEqual(consumer.statuses, []);
  assert.equal(connection.options?.qos?.prefetchCount, 4);
  assert.equal(connection.options?.concurrency, 2);
  assert.equal(connection.options?.noAck, false);
  assert.equal(connection.options?.requeue, false);
  finished.resolve();
  assert.equal(await work, 0);
  await handle.release();
});

test("redelivery and x-death do not invent attempt counters; invalid metadata is omitted", async () => {
  const connection = fakeConsumerConnection();
  const requests: ListenerRequest<number>[] = [];
  const handle = await rabbitmqListener(
    {
      ...options(connection),
    },
    {
      ...context(),
      invoke: async (value) => {
        requests.push(value);
      },
    },
  );
  for (const count of [undefined, -1, 1.5, "3", Number.MAX_SAFE_INTEGER]) {
    await connection.consumer!.deliver({
      redelivered: true,
      headers: { "x-death": [{ count: 10 }], "x-delivery-count": count, "x-openknot-actor-id": 42 },
    });
  }
  assert.ok(requests.every((r) => r.trigger?.attempt === undefined));
  assert.ok(requests.every((r) => r.actor === undefined));
  await connection.consumer!.deliver({ headers: { "x-acquired-count": 4, "x-delivery-count": 1 } });
  assert.equal(requests.at(-1)?.trigger?.attempt, 5);
  await handle.release();
});

test("decode, handler, cancellation and post-commit errors reach the explicit failure policy", async () => {
  const connection = fakeConsumerConnection();
  const kinds: RabbitFailureKind[] = [];
  const expected = [new Error("business"), InputCancelledError("cancelled"), PostCommitError("publications", "nack")];
  const handle = await rabbitmqListener(
    {
      ...options(connection),
      decode: ({ body }) => {
        if (body === "bad") {
          throw new Error("decode");
        }
        return 1;
      },
      failurePolicy: ({ kind }) => {
        kinds.push(kind);
        return kind === "post-commit" ? "ack" : "reject";
      },
    },
    {
      ...context(),
      invoke: async () => {
        throw expected.shift()!;
      },
    },
  );
  assert.equal(await connection.consumer!.deliver({ body: "bad" }), 2);
  for (const status of [2, 2, 0]) {
    assert.equal(await connection.consumer!.deliver(), status);
  }
  assert.deepEqual(kinds, ["decode", "handler", "cancelled", "post-commit"]);
  await handle.release();
});

test("a delivery the input no longer admits returns to the queue without the failure policy", async () => {
  const connection = fakeConsumerConnection();
  let policies = 0;
  const handle = await rabbitmqListener(
    {
      ...options(connection),
      failurePolicy: () => {
        policies++;
        return "reject";
      },
    },
    {
      ...context(),
      invoke: async () => {
        throw InputUnavailableError();
      },
    },
  );
  assert.equal(await connection.consumer!.deliver(), 1);
  assert.equal(policies, 0);
  await handle.release();
});

test("failed failure policies reject through the native DLX path and report the error", async () => {
  const connection = fakeConsumerConnection(),
    reported: unknown[] = [];
  const expected = new Error("policy");
  const handle = await rabbitmqListener(
    {
      ...options(connection),
      failurePolicy: () => {
        throw expected;
      },
      onError: (error) => {
        reported.push(error);
      },
    },
    {
      ...context(),
      invoke: async () => {
        throw new Error("handler");
      },
    },
  );
  assert.equal(await connection.consumer!.deliver(), 2);
  assert.deepEqual(reported, [expected]);
  connection.consumer!.emit("error", expected);
  assert.deepEqual(reported, [expected, expected]);
  await handle.release();
});

test("a native error immediately after ready is reported even before startup's promise continuation", async () => {
  const connection = fakeConsumerConnection(),
    expected = new Error("channel failure"),
    reported: unknown[] = [];
  connection.setup = (consumer) => {
    consumer.start = () => {
      consumer.emit("ready");
      consumer.emit("error", expected);
    };
  };
  const handle = await rabbitmqListener(
    {
      ...options(connection),
      onError: (error) => {
        reported.push(error);
      },
    },
    context(),
  );
  assert.deepEqual(reported, [expected]);
  await handle.release();
});

test("source cancellation stops intake, drains admitted invocations and keeps their signals independent", async () => {
  const connection = fakeConsumerConnection(),
    controller = new AbortController();
  const finished = Promise.withResolvers<void>();
  let request: ListenerRequest<number> | undefined;
  const handle = await rabbitmqListener(
    {
      ...options(connection),
    },
    {
      ...context(),
      signal: controller.signal,
      invoke: async (value) => {
        request = value;
        return finished.promise;
      },
    },
  );
  const work = connection.consumer!.deliver();
  controller.abort();
  assert.equal(connection.consumer!.stopping, true);
  assert.equal(request?.signal, undefined);
  let stopped = false;
  const stopping = Promise.resolve(handle.release()).then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  finished.resolve();
  await Promise.all([work, stopping, handle.release()]);
  assert.deepEqual(connection.consumer!.statuses, [0]);
  assert.equal(connection.consumer!.closed, 1);
});

test("startup failures and cancellation close partially acquired consumers and remove abort listeners", async () => {
  const connection = fakeConsumerConnection(),
    expected = new Error("declaration mismatch");
  connection.setup = (consumer) => {
    consumer.startupError = expected;
  };
  await assert.rejects(rabbitmqListener(options(connection), context()), (error) => error === expected);
  assert.equal(connection.consumer!.closed, 1);
  assert.equal(connection.consumer!.listenerCount("ready"), 0);

  const controller = new AbortController();
  connection.setup = (consumer) => {
    consumer.autoReady = false;
  };
  const starting = rabbitmqListener(options(connection), { ...context(), signal: controller.signal });
  const rejected = assert.rejects(starting, /cancel startup/);
  controller.abort(new Error("cancel startup"));
  await rejected;
  assert.equal(connection.consumer!.closed, 1);

  const aborted = fakeConsumerConnection();
  await assert.rejects(rabbitmqListener(options(aborted), { ...context(), signal: AbortSignal.abort() }));
  assert.equal(aborted.consumer, undefined);
});

test("native consumer options pass through while the adapter owns acknowledgments and startup", async () => {
  const connection = fakeConsumerConnection();
  const consumer: ConsumerProps = {
    queue: "roles",
    consumerTag: "role-listener",
    exclusive: true,
    noLocal: true,
    arguments: { "x-priority": 3 },
    queueOptions: { durable: true, arguments: { "x-queue-type": "quorum" } },
    qos: { prefetchCount: 0, prefetchSize: 1024, global: true },
    concurrency: Infinity,
    exchanges: [{ exchange: "events", type: "topic" }],
    queueBindings: [{ queue: "roles", exchange: "events", routingKey: "role.*" }],
    exchangeBindings: [{ destination: "events", source: "upstream", routingKey: "#" }],
    lazy: false,
    noAck: true,
    requeue: true,
  };
  const handle = await rabbitmqListener({ ...options(connection), consumer }, context());
  try {
    assert.deepEqual(connection.options, { ...consumer, lazy: true, noAck: false, requeue: false });
    assert.equal(await connection.consumer!.deliver(), 0);
  } finally {
    await handle.release();
  }
});

test("omitted consumer tuning retains native defaults", async () => {
  const connection = fakeConsumerConnection();
  const handle = await rabbitmqListener({ ...options(connection), consumer: { queue: "roles" } }, context());
  try {
    assert.equal(connection.options?.qos, undefined);
    assert.equal(connection.options?.concurrency, undefined);
    assert.equal(await connection.consumer!.deliver(), 0);
  } finally {
    await handle.release();
  }
});
