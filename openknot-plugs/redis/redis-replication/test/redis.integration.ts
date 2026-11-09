import { redisConnections } from "../examples/native.ts";
import { redisReplicaStoreOf, redisReplicationChannelOf } from "../src/index.ts";
import type { ReplicaChange, ReplicationMessage } from "@openknot-ts/replication";
import { ReplicaFenced } from "@openknot-ts/replication";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const url = process.env.REDIS_URL;
const skip = url === undefined ? "set REDIS_URL to run against Redis" : false;
const role = (id: string, version: number) => ({ entity: "role", id, name: `role ${version}`, version });
const set = (id: string, version: number): ReplicaChange => ({
  entity: "role",
  id,
  order: version,
  type: "set",
  value: role(id, version),
});
const remove = (id: string, version: number): ReplicaChange => ({ entity: "role", id, order: version, type: "delete" });

test("the store applies newer states and keeps tombstones", { skip }, async () => {
  const connection = await redisConnections(url!);
  const prefix = `openknot-test:${randomUUID()}`;
  const store = redisReplicaStoreOf(connection.commands, { prefix, tombstoneTtl: 60_000 });
  const keyspace = "role:v1";
  try {
    assert.equal((await store.apply(keyspace, [set("r1", 1), set("r2", 1)])).length, 2);
    assert.deepEqual(await store.apply(keyspace, [set("r1", 0), set("r1", 1)]), []);
    assert.deepEqual(await store.apply(keyspace, [set("r1", 2)]), [set("r1", 2)]);
    assert.deepEqual(await store.get(keyspace, "role", "r1"), role("r1", 2));
    assert.deepEqual(await store.apply(keyspace, [remove("r2", 1)]), [remove("r2", 1)]);
    assert.equal(await store.get(keyspace, "role", "r2"), undefined);
    assert.deepEqual(
      await store.apply(keyspace, [set("r2", 1)]),
      [],
      "a late set does not bring back a deleted entity",
    );
    const tombstone = `${prefix}:{${keyspace}}:tomb:["role","string:r2"]`;
    assert.ok(Number(await connection.commands.sendCommand(["PTTL", tombstone])) > 0);
    assert.deepEqual(await store.apply(keyspace, [set("r2", 2)]), [set("r2", 2)]);
    assert.deepEqual((await store.list(keyspace, "role")).map((value) => (value as { id: string }).id).sort(), [
      "r1",
      "r2",
    ]);
    assert.match(await store.runId(), /^[0-9a-f]+$/);
    await store.mark(keyspace, { state: "complete", dirty: true, runId: "run" });
    assert.deepEqual(await store.marker(keyspace), { state: "complete", dirty: true, runId: "run" });
    await store.drop(keyspace);
    assert.equal(await store.marker(keyspace), undefined);
    assert.deepEqual(await store.list(keyspace, "role"), []);
  } finally {
    await store.drop(keyspace);
    await connection.close();
  }
});

test("tombstones keep different entity and id tuples independent", { skip }, async () => {
  const connection = await redisConnections(url!);
  const store = redisReplicaStoreOf(connection.commands, { prefix: `openknot-test:${randomUUID()}` });
  const keyspace = "shared:v1";
  const deleted: ReplicaChange = { entity: "role", id: "string:1", order: 10, type: "delete" };
  const distinct: ReplicaChange = {
    entity: "role:string",
    id: "1",
    order: 1,
    type: "set",
    value: { entity: "role:string", id: "1", version: 1 },
  };
  try {
    await store.apply(keyspace, [deleted]);
    assert.deepEqual(await store.apply(keyspace, [distinct]), [distinct]);
    assert.deepEqual(await store.get(keyspace, distinct.entity, distinct.id), distinct.value);
    assert.deepEqual(await store.apply(keyspace, [set("string:1", 9)]), []);
  } finally {
    await store.drop(keyspace);
    await connection.close();
  }
});

test("a fenced store rejects an older holder", { skip }, async () => {
  const connection = await redisConnections(url!);
  const prefix = `openknot-test:${randomUUID()}`;
  const store = redisReplicaStoreOf(connection.commands, { prefix, tombstoneTtl: 60_000 });
  const keyspace = "role:v1";
  try {
    await store.mark(keyspace, { state: "loading", dirty: false, runId: "run-a", holder: "a" });
    assert.deepEqual(await store.apply(keyspace, [set("r1", 1)], "a"), [set("r1", 1)]);
    // Take over with holder b.
    await store.mark(keyspace, { state: "loading", dirty: false, runId: "run-b", holder: "b" });
    await assert.rejects(() => store.apply(keyspace, [set("r2", 1)], "a"), ReplicaFenced.is);
    await assert.rejects(
      () => store.mark(keyspace, { state: "complete", dirty: false, runId: "run-a", holder: "a" }, "a"),
      ReplicaFenced.is,
    );
    await assert.rejects(() => store.clear(keyspace, "a"), ReplicaFenced.is);
    // Holder b can clear states while keeping the marker.
    await store.clear(keyspace, "b");
    assert.deepEqual(await store.list(keyspace, "role"), []);
    assert.ok((await store.marker(keyspace)) !== undefined);
  } finally {
    await store.drop(keyspace);
    await connection.close();
  }
});

test("scripts run again after SCRIPT FLUSH", { skip }, async () => {
  const connection = await redisConnections(url!);
  const prefix = `openknot-test:${randomUUID()}`;
  const store = redisReplicaStoreOf(connection.commands, { prefix, tombstoneTtl: 60_000 });
  const keyspace = "role:v1";
  try {
    assert.deepEqual(await store.apply(keyspace, [set("r1", 1)]), [set("r1", 1)]);
    await connection.commands.sendCommand(["SCRIPT", "FLUSH"]);
    assert.deepEqual(await store.apply(keyspace, [set("r2", 2)]), [set("r2", 2)]);
  } finally {
    await store.drop(keyspace);
    await connection.close();
  }
});

test("drop leaves no keys", { skip }, async () => {
  const connection = await redisConnections(url!);
  const prefix = `openknot-test:${randomUUID()}`;
  const store = redisReplicaStoreOf(connection.commands, { prefix, tombstoneTtl: 60_000 });
  const keyspace = "role:v1";
  try {
    await store.apply(keyspace, [set("r1", 1)]);
    await store.mark(keyspace, { state: "complete", dirty: false, runId: "run" });
    await store.drop(keyspace);
    let cursor = "0";
    let foundCount = 0;
    do {
      const [next, found] = (await connection.commands.sendCommand([
        "SCAN",
        cursor,
        "MATCH",
        `${prefix}:{${keyspace}}:*`,
        "COUNT",
        "500",
      ])) as [unknown, readonly unknown[]];
      cursor = String(next);
      foundCount += found.length;
    } while (cursor !== "0");
    assert.equal(foundCount, 0);
  } finally {
    await store.drop(keyspace);
    await connection.close();
  }
});

test("the channel delivers published messages to subscribers", { skip }, async () => {
  const publisher = await redisConnections(url!);
  const listening = await redisConnections(url!);
  const channel = redisReplicationChannelOf(
    { commands: publisher.commands, subscriber: listening.subscriber },
    { channel: `openknot-test:${randomUUID()}` },
  );
  let received: (message: ReplicationMessage) => void = () => undefined;
  const delivered = new Promise<ReplicationMessage>((resolve) => {
    received = resolve;
  });
  const subscription = await channel.subscribe({ message: received, lost: () => undefined, restored: () => undefined });
  const message: ReplicationMessage = {
    type: "changes",
    origin: "a",
    keyspace: "role:v1",
    changes: [{ entity: "role", id: 12n, order: 3n, type: "set" }],
  };
  try {
    await channel.publish(message);
    assert.deepEqual(await delivered, message);
  } finally {
    await subscription.close();
    await Promise.all([publisher.close(), listening.close()]);
  }
});

test("clear treats the keyspace literally", { skip }, async () => {
  const connection = await redisConnections(url!);
  const prefix = `openknot-test:${randomUUID()}`;
  const store = redisReplicaStoreOf(connection.commands, { prefix, tombstoneTtl: 60_000 });
  const marked = { state: "loading", dirty: false, runId: "run", holder: "a" } as const;
  const keyspaces = ["ro[l]e:v1", "a*:v1", "ab:v1"];
  try {
    for (const keyspace of keyspaces) {
      await store.mark(keyspace, marked);
      await store.apply(keyspace, [set("r1", 1)]);
    }
    await store.clear("ro[l]e:v1", "a");
    assert.deepEqual(await store.list("ro[l]e:v1", "role"), []);
    await store.clear("a*:v1", "a");
    assert.deepEqual(await store.list("a*:v1", "role"), []);
    assert.deepEqual(await store.list("ab:v1", "role"), [role("r1", 1)]);
    assert.deepEqual(await store.marker("ab:v1"), marked);
  } finally {
    for (const keyspace of keyspaces) {
      await store.drop(keyspace);
    }
    await connection.close();
  }
});

test("a stale fence rejects even when there is nothing to write", { skip }, async () => {
  const connection = await redisConnections(url!);
  const prefix = `openknot-test:${randomUUID()}`;
  const store = redisReplicaStoreOf(connection.commands, { prefix, tombstoneTtl: 60_000 });
  const keyspace = "role:v1";
  try {
    await assert.rejects(() => store.clear(keyspace, "a"), ReplicaFenced.is, "a dropped marker has no holder");
    await assert.rejects(() => store.apply(keyspace, [], "a"), ReplicaFenced.is, "a dropped marker has no holder");
    await store.mark(keyspace, { state: "loading", dirty: false, runId: "run", holder: "b" });
    await assert.rejects(() => store.clear(keyspace, "a"), ReplicaFenced.is);
    await assert.rejects(() => store.apply(keyspace, [], "a"), ReplicaFenced.is);
    await store.clear(keyspace, "b");
    assert.deepEqual(await store.apply(keyspace, [], "b"), []);
    assert.deepEqual(await store.apply(keyspace, []), []);
  } finally {
    await store.drop(keyspace);
    await connection.close();
  }
});
