import { redisLockOf } from "../src/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createClient } from "redis";

const url = process.env.REDIS_URL ?? "";
const skip = url === "" ? "set REDIS_URL to run against Redis" : false;

async function connected() {
  const client = createClient({ url }).on("error", console.error);
  await client.connect();
  return client;
}

test(
  "one of several concurrent attempts holds the lock, under the native lease, until it releases",
  { skip, timeout: 10_000 },
  async (t) => {
    const prefix = `openknot-test:${randomUUID()}`;
    const clients = await Promise.all([1, 2, 3, 4, 5].map(connected));
    const admin = await connected();
    // The holder keeps working until the four other attempts were refused, or the test times out.
    const othersRefused = Promise.withResolvers<void>();
    t.signal.addEventListener("abort", () => othersRefused.reject(t.signal.reason), { once: true });
    let refused = 0;
    try {
      const results = await Promise.all(
        clients.map((client) =>
          redisLockOf(client, { prefix })
            .tryRun("job", { leaseMs: 10_000 }, async () => {
              const ttl = Number(await admin.sendCommand(["PTTL", `${prefix}:job`]));
              assert.ok(ttl > 0 && ttl <= 10_000, `lease ${ttl}ms`);
              await othersRefused.promise;
            })
            .then((result) => {
              if (!result.acquired && ++refused === clients.length - 1) {
                othersRefused.resolve();
              }
              return result;
            }),
        ),
      );
      assert.equal(results.filter((result) => result.acquired).length, 1);
      assert.equal(await admin.sendCommand(["EXISTS", `${prefix}:job`]), 0);
    } finally {
      await Promise.all([...clients, admin].map((client) => client.close()));
    }
  },
);

test("a holder whose lease ended does not release the next holder's lock", { skip }, async () => {
  const prefix = `openknot-test:${randomUUID()}`;
  const client = await connected();
  const lockOf = redisLockOf(client, { prefix });
  const key = `${prefix}:job`;
  try {
    const first = await lockOf.tryRun("job", { leaseMs: 10_000 }, async () => {
      // Deleting the key stands in for the native expiry of the first holder's lease.
      await client.sendCommand(["DEL", key]);
      const next = await lockOf.tryRun("job", { leaseMs: 10_000 }, async () => client.sendCommand(["GET", key]));
      assert.ok(next.acquired);
      await client.sendCommand(["SET", key, String(next.value)]);
    });
    assert.ok(first.acquired);
    assert.notEqual(await client.sendCommand(["GET", key]), null);
  } finally {
    await client.sendCommand(["DEL", key]);
    await client.close();
  }
});
