import { redisBroadcast, redisTopic, SubscriptionLostError } from "../src/index.ts";
import type { RedisPublisher, RedisShardedSubscriber } from "../src/index.ts";
import { connectionWatch } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

type Listener = (message: string, channel: string) => unknown;

function redis() {
  const calls: string[] = [];
  const channels = new Map<string, Listener>();
  const unsubscribed = new Map<string, () => void>();
  const outages = new EventEmitter();
  const fault: { subscribe?: unknown; unsubscribe?: unknown } = {};
  const subscriber: RedisShardedSubscriber = {
    sSubscribe: async (name, listener) => {
      calls.push(`SSUBSCRIBE ${String(name)}`);
      if (fault.subscribe !== undefined) {
        throw fault.subscribe;
      }
      channels.set(String(name), listener as Listener);
    },
    sUnsubscribe: async (name) => {
      calls.push(`SUNSUBSCRIBE ${String(name)}`);
      channels.delete(String(name));
      unsubscribed.get(String(name))?.();
      if (fault.unsubscribe !== undefined) {
        throw fault.unsubscribe;
      }
    },
  };
  const commands: RedisPublisher = {
    sendCommand: async (args) => {
      calls.push(args.join(" "));
      const name = String(args[1]);
      channels.get(name)?.(String(args[2]), name);
      return 1;
    },
  };
  const connection = connectionWatch(({ lost, restored }) => {
    outages.on("lost", lost);
    outages.on("restored", restored);
    return () => {
      outages.off("lost", lost);
      outages.off("restored", restored);
    };
  });
  return {
    calls,
    channels,
    fault,
    outages,
    clients: { commands, subscriber, connection },
    /** Resolves once the channel is unsubscribed; call it before the action that unsubscribes. */
    left: (name: string) => new Promise<void>((resolve) => unsubscribed.set(name, resolve)),
  };
}

test("local subscribers of a key share one channel subscription, which ends after the last of them", async (t) => {
  const native = redis();
  const managed = await redisTopic<string, { readonly n: number }>({
    ...native.clients,
    channel: (key) => `roles:${key}`,
  });
  t.after(() => managed.release());
  const delivery = managed.value;
  const first = await delivery.subscribe("1");
  const second = await delivery.subscribe("1");
  const other = await delivery.subscribe("2");
  assert.deepEqual(native.calls, ["SSUBSCRIBE roles:1", "SSUBSCRIBE roles:2"]);

  await delivery.publish("1", { n: 1 });
  await delivery.publish("2", { n: 2 });
  assert.deepEqual(native.calls.slice(2), ['SPUBLISH roles:1 {"n":1}', 'SPUBLISH roles:2 {"n":2}']);
  assert.deepEqual(await first.next(), { done: false, value: { n: 1 } });
  assert.deepEqual(await second.next(), { done: false, value: { n: 1 } });
  assert.deepEqual(await other.next(), { done: false, value: { n: 2 } });

  await first.return!();
  assert.equal(native.channels.has("roles:1"), true);
  const left = native.left("roles:1");
  await second.return!();
  await left;
  assert.equal(native.channels.has("roles:1"), false);
  assert.equal(native.channels.has("roles:2"), true);
});

test("a payload that does not decode is dropped", async (t) => {
  const native = redis();
  const managed = await redisTopic<string, string>({ ...native.clients, channel: (key) => key });
  t.after(() => managed.release());
  const messages = await managed.value.subscribe("logs");
  native.channels.get("logs")!("not json", "logs");
  await managed.value.publish("logs", "created");
  assert.deepEqual(await messages.next(), { done: false, value: "created" });
});

test("a lost subscriber connection ends every subscription and refuses new ones until it is restored", async (t) => {
  const native = redis();
  const managed = await redisTopic<string, string>({ ...native.clients, channel: (key) => key });
  t.after(() => managed.release());
  const delivery = managed.value;
  const messages = await delivery.subscribe("roles");
  const waiting = messages.next();
  const left = native.left("roles");
  native.outages.emit("lost");
  await assert.rejects(waiting, SubscriptionLostError.is);
  await left;
  await assert.rejects(delivery.subscribe("roles"), SubscriptionLostError.is);

  native.outages.emit("restored");
  const restored = await delivery.subscribe("roles");
  await delivery.publish("roles", "after");
  assert.deepEqual(await restored.next(), { done: false, value: "after" });
  assert.deepEqual(native.calls.slice(0, 3), ["SSUBSCRIBE roles", "SUNSUBSCRIBE roles", "SSUBSCRIBE roles"]);
});

test("a refused channel subscription rejects subscribe and a later subscription subscribes again", async (t) => {
  const native = redis();
  const managed = await redisTopic<string, string>({ ...native.clients, channel: (key) => key });
  t.after(() => managed.release());
  const refusal = new Error("NOPERM");
  native.fault.subscribe = refusal;
  await assert.rejects(managed.value.subscribe("roles"), (error) => error === refusal);
  delete native.fault.subscribe;
  const messages = await managed.value.subscribe("roles");
  await managed.value.publish("roles", "delivered");
  assert.deepEqual(await messages.next(), { done: false, value: "delivered" });
  assert.deepEqual(native.calls.slice(0, 2), ["SSUBSCRIBE roles", "SSUBSCRIBE roles"]);
});

test("a broadcast delivers on its channel, and release ends it and reports a failed unsubscription", async () => {
  const native = redis();
  const managed = await redisBroadcast<string>({ ...native.clients, channel: "logs" });
  const messages = await managed.value.subscribe();
  await managed.value.publish("created");
  assert.deepEqual(await messages.next(), { done: false, value: "created" });
  const refusal = new Error("connection closed");
  native.fault.unsubscribe = refusal;
  await assert.rejects(
    async () => managed.release(),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === refusal,
  );
  assert.deepEqual(await messages.next(), { done: true, value: undefined });
  await assert.rejects(managed.value.subscribe(), /released/);
});
