import { inMemoryBroadcast, inMemoryTopic, SlowSubscriberError } from "../src/index.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

/** The current job keeps the objects it created alive until it ends: two turns of the event loop, then a collection. */
async function collect(): Promise<void> {
  const gc = (globalThis as { gc?: (options: object) => void }).gc ?? assert.fail("run with node --expose-gc");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // A full collection: a single regular cycle can leave unreachable objects behind under load.
  gc({ type: "major", execution: "sync", flavor: "last-resort" });
}

type Audience = { readonly userId: string; readonly roleId: number; readonly scope: "summary" | "detail" };
type Change = { readonly type: "RoleChanged"; readonly name: string };
const event = (key: Audience) => `roles:${JSON.stringify([key.userId, key.roleId, key.scope])}`;
const alice: Audience = { userId: "alice", roleId: 7, scope: "detail" };

test("native routing uses the supplied structured-key encoding and exposes unique active audiences", async (t) => {
  const events = new EventEmitter();
  const managed = await inMemoryTopic<Audience, Change>({ events, event });
  t.after(() => managed.release());
  const delivery = managed.value;
  const first = delivery.subscribe(alice);
  const duplicate = delivery.subscribe({ ...alice });
  const bob = delivery.subscribe({ ...alice, userId: "bob" });
  const summary = delivery.subscribe({ ...alice, scope: "summary" });
  const anotherRole = delivery.subscribe({ ...alice, roleId: 8 });
  assert.equal(events.listenerCount(event(alice)), 2);
  assert.equal(delivery.subscriberCount({ ...alice }), 2);
  assert.deepEqual(delivery.keys(), [
    alice,
    { ...alice, userId: "bob" },
    { ...alice, scope: "summary" },
    { ...alice, roleId: 8 },
  ]);
  assert.equal(Object.isFrozen(delivery.keys()), true);

  const message: Change = { type: "RoleChanged", name: "Administrator" };
  delivery.publish({ ...alice }, message);
  assert.equal((await first.next()).value, message, "Delivery preserves the application payload identity.");
  assert.equal((await duplicate.next()).value, message);
  await first.return!();
  assert.equal(delivery.subscriberCount(alice), 1);
  await duplicate.return!();
  assert.equal(delivery.subscriberCount(alice), 0);
  assert.equal(delivery.keys().length, 3);
  for (const other of [bob, summary, anotherRole]) {
    const pending = other.next();
    await other.return!();
    assert.deepEqual(await pending, { done: true, value: undefined }, "Unmatched audiences receive no data.");
  }
  assert.deepEqual(delivery.keys(), []);
});

test("subscriptions attach before the first read and have no replay after unsubscribe", async (t) => {
  const events = new EventEmitter();
  const managed = await inMemoryTopic<number, number>({ events, event: (key) => `number:${key}` });
  t.after(() => managed.release());
  const first = managed.value.subscribe(42);
  managed.value.publish(42, 1);
  managed.value.publish(42, 2);
  assert.deepEqual(await first.next(), { done: false, value: 1 });
  assert.deepEqual(await first.next(), { done: false, value: 2 });
  await first.return!();
  managed.value.publish(42, 3);
  const second = managed.value.subscribe(42);
  managed.value.publish(42, 4);
  assert.deepEqual(await second.next(), { done: false, value: 4 });
});

test("native symbols isolate broadcast routes on a shared emitter", async (t) => {
  const events = new EventEmitter();
  const logs = await inMemoryBroadcast<string>({ events, event: Symbol("logs") });
  const alerts = await inMemoryBroadcast<string>({ events, event: Symbol("logs") });
  t.after(async () => {
    await logs.release();
    await alerts.release();
  });
  const first = logs.value.subscribe();
  const second = logs.value.subscribe();
  const other = alerts.value.subscribe();
  logs.value.publish("created");
  assert.deepEqual(await first.next(), { done: false, value: "created" });
  assert.deepEqual(await second.next(), { done: false, value: "created" });
  const pending = other.next();
  assert.equal(logs.value.subscriberCount(), 2);
  await alerts.release();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(logs.value.subscriberCount(), 2);
});

test("return, throw and for-await break release native subscriptions, including a pending read", async (t) => {
  const events = new EventEmitter();
  const managed = await inMemoryBroadcast<number>({ events, event: "data" });
  t.after(() => managed.release());
  const unstarted = managed.value.subscribe();
  await unstarted.return!();
  assert.equal(events.listenerCount("data"), 0);
  const reading = managed.value.subscribe();
  const pending = reading.next();
  await reading.return!();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await reading.next(), { done: true, value: undefined });
  const throwing = managed.value.subscribe();
  const defect = new Error("consumer failed");
  await assert.rejects(throwing.throw!(defect), (error) => error === defect);
  const breaking = managed.value.subscribe();
  managed.value.publish(1);
  for await (const value of breaking) {
    assert.equal(value, 1);
    break;
  }
  assert.equal(managed.value.subscriberCount(), 0);
  assert.equal(events.listenerCount("data"), 0);
});

test("ended subscriptions keep neither their streams, keys nor unread messages reachable", async (t) => {
  const events = new EventEmitter();
  const managed = await inMemoryTopic<Audience, Change>({ events, event });
  t.after(() => managed.release());
  const kept: WeakRef<object>[] = [];
  // Each subscription owns its key, stream and messages, so no frame of this test keeps one.
  const subscribe = async (index: number) => {
    const key: Audience = { userId: `user${index}`, roleId: index, scope: "detail" };
    const caller = new AbortController();
    const stream = managed.value.subscribe(key, { signal: caller.signal });
    const message: Change = { type: "RoleChanged", name: `role${index}` };
    kept.push(new WeakRef(key), new WeakRef(stream), new WeakRef(message));
    managed.value.publish({ ...key }, message);
    if (index % 2 === 0) {
      await stream.return!();
    } else {
      caller.abort();
    }
  };
  for (let index = 0; index < 40; index++) {
    await subscribe(index);
  }
  await collect();
  assert.deepEqual(managed.value.keys(), []);
  assert.equal(events.eventNames().length, 0);
  assert.equal(kept.filter((value) => value.deref() !== undefined).length, 0);
});

test("abort releases pending or unread subscriptions without retaining lifetime listeners", async (t) => {
  const events = new EventEmitter();
  const managed = await inMemoryBroadcast<number>({ events, event: "data" });
  t.after(() => managed.release());
  const controller = new AbortController();
  const reading = managed.value.subscribe({ signal: controller.signal });
  const unread = managed.value.subscribe({ signal: controller.signal });
  managed.value.publish(1);
  assert.deepEqual(await reading.next(), { done: false, value: 1 });
  const pending = reading.next();
  controller.abort();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await unread.next(), { done: true, value: undefined });
  assert.equal(events.listenerCount("data"), 0);
  assert.throws(() => managed.value.subscribe({ signal: controller.signal }), { name: "AbortError" });
  const active = managed.value.subscribe();
  assert.throws(() => managed.value.publish(2, { signal: controller.signal }), { name: "AbortError" });
  const unfulfilled = active.next();
  await active.return!();
  assert.deepEqual(await unfulfilled, { done: true, value: undefined });
});

test("overflow errors and detaches only the slow subscription while publishers and fast readers continue", async (t) => {
  const events = new EventEmitter();
  const managed = await inMemoryTopic<string, number>({ events, event: (key) => key, capacity: 2 });
  t.after(() => managed.release());
  const slow = managed.value.subscribe("data");
  const fast = managed.value.subscribe("data");
  for (const value of [1, 2, 3]) {
    const next = fast.next();
    assert.doesNotThrow(() => managed.value.publish("data", value));
    assert.deepEqual(await next, { done: false, value });
  }
  assert.equal(events.listenerCount("data"), 1);
  assert.equal(managed.value.subscriberCount("data"), 1);
  await assert.rejects(slow.next(), (error) => SlowSubscriberError.is(error) && error.capacity === 2);
  await slow.return!();
  managed.value.publish("data", 4);
  assert.deepEqual(await fast.next(), { done: false, value: 4 });
  await fast.return!();
  assert.deepEqual(managed.value.keys(), []);
});

test("managed release closes pending and unread streams while preserving foreign native listeners", async () => {
  const events = new EventEmitter();
  const seen: number[] = [];
  const foreign = (value: number) => {
    seen.push(value);
  };
  events.setMaxListeners(27);
  events.on("data", foreign);
  const managed = await inMemoryTopic<string, number>({ events, event: (key) => key });
  const active = managed.value.subscribe("data");
  const unread = managed.value.subscribe("data");
  const other = managed.value.subscribe("other");
  const pending = active.next();
  const anotherPending = other.next();
  const releasing = managed.release();
  await releasing;
  await managed.release();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await anotherPending, { done: true, value: undefined });
  assert.deepEqual(await unread.next(), { done: true, value: undefined });
  assert.equal(events.getMaxListeners(), 27);
  assert.deepEqual(events.listeners("data"), [foreign]);
  assert.deepEqual(events.eventNames(), ["data"]);
  events.emit("data", 5);
  assert.deepEqual(seen, [5]);
  assert.deepEqual(managed.value.keys(), []);
  assert.throws(() => managed.value.publish("data", 6), /closed/);
  assert.throws(() => managed.value.subscribe("data"), /closed/);
});

test("resources sharing a native event clean up only their own subscriptions", async () => {
  const events = new EventEmitter();
  const first = await inMemoryBroadcast<string>({ events, event: "data" });
  const second = await inMemoryBroadcast<string>({ events, event: "data" });
  try {
    first.value.subscribe();
    const subscription = second.value.subscribe();
    await first.release();
    assert.equal(events.listenerCount("data"), 1);
    second.value.publish("active");
    assert.deepEqual(await subscription.next(), { done: false, value: "active" });
    assert.equal(second.value.subscriberCount(), 1);
  } finally {
    await first.release();
    await second.release();
  }
});

test("initialization failure removes a partially attached native subscription", async (t) => {
  const events = new EventEmitter();
  const managed = await inMemoryBroadcast<number>({ events, event: "data" });
  t.after(() => managed.release());
  const defect = new Error("native registration failed");
  const failing = () => {
    throw defect;
  };
  events.on("newListener", failing);
  assert.throws(
    () => managed.value.subscribe(),
    (error) => error === defect,
  );
  events.off("newListener", failing);
  assert.equal(events.listenerCount("data"), 0);
  assert.equal(managed.value.subscriberCount(), 0);
});

test("native configuration is snapshotted and invalid capacities fail before acquisition", async (t) => {
  const events = new EventEmitter();
  for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => inMemoryBroadcast({ events, event: "data", capacity }), /positive safe integer/);
  }
  const options = { events, event: "original", capacity: 2 };
  const acquiring = inMemoryBroadcast<number>(options);
  options.event = "changed";
  options.capacity = 0;
  const managed = await acquiring;
  t.after(() => managed.release());
  const subscription = managed.value.subscribe();
  assert.equal(events.listenerCount("original"), 1);
  assert.equal(events.listenerCount("changed"), 0);
  managed.value.publish(1);
  assert.deepEqual(await subscription.next(), { done: false, value: 1 });
});

test("a subscriber that never reads is detached once full and keeps no messages reachable", async () => {
  const events = new EventEmitter();
  const managed = await inMemoryTopic<string, { readonly index: number }>({ events, event: (key) => key, capacity: 2 });
  const kept: WeakRef<object>[] = [];
  try {
    // The consumer keeps its iterator but never asks for a message.
    const idle = managed.value.subscribe("roles");
    // Published from a finished call, so that no suspended frame of this test holds the last message.
    (() => {
      for (let index = 0; index < 100; index++) {
        const message = { index };
        kept.push(new WeakRef(message));
        managed.value.publish("roles", message);
      }
    })();
    assert.equal(events.listenerCount("roles"), 0);
    await collect();
    assert.equal(kept.filter((message) => message.deref() !== undefined).length, 0);
    await assert.rejects(idle.next(), SlowSubscriberError.is);
  } finally {
    await managed.release();
  }
});
