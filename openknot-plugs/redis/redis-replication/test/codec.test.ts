import type { ReplicaSubscriber } from "../src/index.ts";
import {
  decodeMessage,
  encodeMessage,
  encodeOrder,
  redisReplicaStoreOf,
  redisReplicationChannelOf,
} from "../src/index.ts";
import { redisReplicaStore } from "../src/wire.ts";
import { redisReplicationChannel } from "../src/wire.ts";
import type { ReplicationHandlers } from "@openknot-ts/replication";
import { ReplicaFenced, replicaStore } from "@openknot-ts/replication";
import { replicationChannel } from "@openknot-ts/replication";
import { composeModule, connectionWatch, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const steady = { watch: () => () => undefined };

/** A connection the test drops with `lost` and brings back with `restored`; `events` holds its watchers' listeners. */
function outages() {
  const events = new EventEmitter();
  const connection = connectionWatch(({ lost, restored }) => {
    events.on("lost", lost);
    events.on("restored", restored);
    return () => {
      events.off("lost", lost);
      events.off("restored", restored);
    };
  });
  return { events, connection };
}

test("encoded orders compare as strings in the order of their values", () => {
  const orders = [0, 1, 9, 10, 99, 100, 2n ** 60n, "a", "b"] as const;
  const encoded = orders.map(encodeOrder);
  assert.deepEqual([...encoded].sort(), encoded);
  for (const invalid of [-1, 1.5, Number.NaN, 10n ** 20n]) {
    assert.throws(() => encodeOrder(invalid), TypeError);
  }
});

test("messages keep bigint keys and orders, and foreign messages are not replication messages", () => {
  const message = {
    type: "changes",
    origin: "a",
    keyspace: "role:v1",
    changes: [{ entity: "role", id: 12n, order: 3n, type: "set" }],
  } as const;
  assert.deepEqual(decodeMessage(encodeMessage(message)), message);
  assert.equal(decodeMessage(JSON.stringify({ hello: "world" })), undefined);
  assert.equal(decodeMessage(JSON.stringify({ type: "changes", origin: "a", keyspace: "k" })), undefined);
});

test("malformed payloads are not replication messages", () => {
  assert.equal(decodeMessage("not json"), undefined);
});

test("a channel listener does not throw on a malformed payload", async () => {
  const listeners = new Map<string, (message: string) => void>();
  const subscriber: ReplicaSubscriber = {
    subscribe: async (_channel, listener) => {
      listeners.set("message", (message) => listener(message, "test"));
      return undefined;
    },
    unsubscribe: async () => undefined,
  };
  const channel = redisReplicationChannelOf(
    { commands: { sendCommand: async () => 1 }, subscriber },
    { connection: steady },
  );
  const subscription = await channel.subscribe({
    message: () => undefined,
    lost: () => undefined,
    restored: () => undefined,
  });
  const messageListener = listeners.get("message");
  assert.ok(messageListener !== undefined);
  assert.doesNotThrow(() => messageListener!("not json"));
  await subscription.close();
});

test("redisReplicaStoreOf exposes a configured connection", () => {
  const commands = { sendCommand: async () => undefined };
  const connection = { watch: () => () => undefined };
  const store = redisReplicaStoreOf(commands, { connection });
  assert.equal(store.connection, connection);
});

test("redisReplicaStore builds its connection from its requirements", async () => {
  const connection = { watch: () => () => undefined };
  const events = unit({ factory: () => connection });
  const storage = redisReplicaStore({
    requirements: { events },
    commands: () => ({ sendCommand: async () => undefined }),
    connection: ({ events: own }) => own,
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: [{ source: storage }] })] }),
  );
  try {
    const store = await app.withScope((scope) => scope.resolve(replicaStore));
    assert.equal(store.connection, connection);
  } finally {
    await app.stop();
  }
});

test("replica store settings callbacks retain native TTL validation", async () => {
  const settings = unit({ factory: () => ({ ttl: 0 }) });
  const storage = redisReplicaStore({
    requirements: { settings },
    commands: () => ({ sendCommand: async () => undefined }),
    options: ({ settings }) => ({ prefix: "independent", tombstoneTtl: settings.ttl }),
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: [{ source: storage }] })] })),
    /tombstone TTL/,
  );
});

test("script rejections are recognized by their message, whatever their type", async () => {
  const sent: unknown[] = [];
  const rejections = [{ message: "NOSCRIPT No matching script" }, { message: "ERR REPLICA_FENCED" }];
  const store = redisReplicaStoreOf({
    sendCommand: async (arguments_) => {
      sent.push(arguments_[0]);
      throw rejections.shift();
    },
  });
  await assert.rejects(store.mark("role:v1", { state: "complete", dirty: false, runId: "run" }, "a"), ReplicaFenced.is);
  assert.deepEqual(sent, ["EVALSHA", "EVAL"]);
});

const validChange = { entity: "role", id: "r1", order: 1, type: "set" } as const;
const changeMessage = {
  type: "changes",
  origin: "external",
  keyspace: "test:role:v1",
  changes: [validChange],
} as const;
const malformedMessages = [
  ...[
    null,
    [],
    "role",
    1,
    false,
    {},
    { ...validChange, entity: undefined },
    { ...validChange, entity: 1 },
    { ...validChange, id: undefined },
    { ...validChange, id: null },
    { ...validChange, id: {} },
    { ...validChange, id: [] },
    { ...validChange, id: true },
    { ...validChange, order: undefined },
    { ...validChange, order: null },
    { ...validChange, order: {} },
    { ...validChange, order: [] },
    { ...validChange, order: true },
    { ...validChange, type: undefined },
    { ...validChange, type: "update" },
  ].map((change) => JSON.stringify({ ...changeMessage, changes: [validChange, change] })),
  ...["changes", "clear", "ready"].flatMap((type) =>
    [
      { ...changeMessage, type, origin: undefined },
      { ...changeMessage, type, origin: {} },
      { ...changeMessage, type, keyspace: undefined },
      { ...changeMessage, type, keyspace: 1 },
    ].map((message) => JSON.stringify(message)),
  ),
  JSON.stringify({ ...changeMessage, type: "unknown" }),
  JSON.stringify({ ...changeMessage, changes: {} }),
  JSON.stringify({ ...changeMessage, changes: null }),
  JSON.stringify({ ...changeMessage, changes: undefined }),
  '{"type":"changes","origin":"external","keyspace":"test:role:v1","changes":[null]}',
  '{"type":"changes","origin":"external","keyspace":"test:role:v1","changes":[{"entity":"role","id":1e400,"order":1,"type":"set"}]}',
  '{"type":"changes","origin":"external","keyspace":"test:role:v1","changes":[{"entity":"role","id":"r1","order":1e400,"type":"set"}]}',
  '{"type":"changes","origin":"external","keyspace":"test:role:v1","changes":[{"entity":"role","id":{"$bigint":"invalid"},"order":1,"type":"set"}]}',
  "null",
  "[]",
  "1",
  "not json",
];
const validMessages = [
  changeMessage,
  {
    ...changeMessage,
    changes: [
      { entity: "role", id: 2, order: 2, type: "delete" },
      { entity: "role", id: 3n, order: 3n, type: "set" },
      { entity: "role", id: "r4", order: "revision", type: "delete" },
    ],
  },
  { ...changeMessage, changes: [] },
  { type: "clear", origin: "external", keyspace: "test:role:v1" },
  { type: "ready", origin: "external", keyspace: "test:role:v1" },
] as const;

test("decodeMessage drops malformed change entries and envelopes", () => {
  for (const payload of malformedMessages) {
    assert.equal(decodeMessage(payload), undefined, payload);
  }
  for (const message of validMessages) {
    assert.deepEqual(decodeMessage(encodeMessage(message)), message);
  }
});

test("the channel drops malformed change entries before invoking its listener", async (t) => {
  const listeners = new Map<string, (message: string) => void>();
  const subscriber: ReplicaSubscriber = {
    subscribe: async (_channel, listener) => {
      listeners.set("message", (message) => listener(message, "test"));
    },
    unsubscribe: async () => {
      listeners.delete("message");
    },
  };
  const channel = redisReplicationChannelOf(
    { commands: { sendCommand: async () => 1 }, subscriber },
    { connection: steady },
  );
  const delivered: Parameters<ReplicationHandlers["message"]>[0][] = [];
  const ids: (string | number | bigint)[] = [];
  const subscription = await channel.subscribe({
    message: (message) => {
      if (message.type === "changes") {
        ids.push(...message.changes.map((change) => change.id));
      }
      delivered.push(message);
    },
    lost: () => undefined,
    restored: () => undefined,
  });
  t.after(() => subscription.close());
  const listener = listeners.get("message");
  assert.ok(listener);
  for (const payload of malformedMessages) {
    assert.doesNotThrow(() => listener(payload), payload);
    assert.deepEqual(delivered, [], payload);
  }
  for (const message of validMessages) {
    listener(encodeMessage(message));
  }
  assert.deepEqual(delivered, validMessages);
  assert.deepEqual(ids, ["r1", 2, 3n, "r4"]);
});

test("a subscription reports its connection's outages until it closes, and a failed one stops watching", async () => {
  const { events, connection } = outages();
  const refusal = new Error("Subscription denied");
  let denied = true;
  const subscriber: ReplicaSubscriber = {
    subscribe: async () => {
      if (denied) {
        throw refusal;
      }
      return undefined;
    },
    unsubscribe: async () => undefined,
  };
  const channel = redisReplicationChannelOf({ commands: { sendCommand: async () => 1 }, subscriber }, { connection });
  const observed: string[] = [];
  const handlers: ReplicationHandlers = {
    message: () => undefined,
    lost: () => {
      observed.push("lost");
    },
    restored: () => {
      observed.push("restored");
    },
  };
  await assert.rejects(channel.subscribe(handlers), (error) => error === refusal);
  assert.equal(events.listenerCount("lost"), 0);
  denied = false;
  const subscription = await channel.subscribe(handlers);
  try {
    events.emit("lost");
    events.emit("restored");
    assert.deepEqual(observed, ["lost", "restored"]);
  } finally {
    await subscription.close();
  }
  assert.equal(events.listenerCount("lost"), 0);
  events.emit("lost");
  events.emit("restored");
  assert.deepEqual(observed, ["lost", "restored"]);
});

test("redisReplicationChannel subscribes and watches on what its requirements resolve", async () => {
  const subscribed: string[] = [];
  const subscriber: ReplicaSubscriber = {
    subscribe: async (channel) => {
      subscribed.push(String(channel));
      return undefined;
    },
    unsubscribe: async () => undefined,
  };
  const { events, connection } = outages();
  const redis = unit({
    factory: () => ({ commands: { sendCommand: async () => 1 }, subscriber, connection: { subscriber: connection } }),
  });
  const settings = unit({ factory: () => ({ channel: "app" }) });
  const binding = redisReplicationChannel({
    requirements: { redis, settings },
    connections: ({ redis }) => redis,
    connection: ({ redis }) => redis.connection.subscriber,
    channel: ({ settings }) => settings.channel,
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: [{ source: redis }, { source: binding }] })] }),
  );
  try {
    const channel = await app.withScope((scope) => scope.resolve(replicationChannel));
    const subscription = await channel.subscribe({
      message: () => undefined,
      lost: () => undefined,
      restored: () => undefined,
    });
    assert.deepEqual(subscribed, ["app"]);
    assert.equal(events.listenerCount("lost"), 1);
    await subscription.close();
  } finally {
    await app.stop();
  }
});
