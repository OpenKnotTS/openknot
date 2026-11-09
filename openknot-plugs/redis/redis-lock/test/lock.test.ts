import type { LockCommands } from "../src/index.ts";
import { redisLockOf } from "../src/index.ts";
import { redisLock } from "../src/wire.ts";
import { lock } from "@openknot-ts/lock/wire";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

function fakeRedis(): LockCommands & { readonly keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    async sendCommand(arguments_) {
      const [command, key, value, ...rest] = arguments_.map(String);
      if (command === "SET" && rest[0] === "NX") {
        if (keys.has(key!)) {
          return null;
        }
        keys.set(key!, value!);
        return "OK";
      }
      if (command === "EVAL") {
        const [, lockKey, token] = [value, rest[0], rest[1]];
        if (keys.get(lockKey!) === token) {
          keys.delete(lockKey!);
        }
        return 1;
      }
      throw new Error(`Unexpected command ${String(command)}`);
    },
  };
}

test("only one holder runs, and release removes only its own token", async () => {
  const redis = fakeRedis();
  const lock = redisLockOf(redis);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = lock.tryRun("rebuild", { leaseMs: 1000 }, async () => {
    await held;
    return 1;
  });
  assert.deepEqual(await lock.tryRun("rebuild", { leaseMs: 1000 }, async () => 2), { acquired: false });
  release();
  assert.deepEqual(await first, { acquired: true, value: 1 });
  assert.equal(redis.keys.size, 0);
});

test("a failing release does not hide the work's failure", async () => {
  const workError = new Error("work failed");
  const releaseError = new Error("release failed");
  const commands: LockCommands = {
    async sendCommand([command]) {
      if (command === "SET") {
        return "OK";
      }
      if (command === "EVAL") {
        throw releaseError;
      }
      throw new Error(`Unexpected command ${String(command)}`);
    },
  };
  const lock = redisLockOf(commands);
  await assert.rejects(
    lock.tryRun("rebuild", { leaseMs: 1000 }, async () => {
      throw workError;
    }),
    (error: unknown) => {
      assert.ok(typeof error === "object" && error !== null);
      assert.ok("name" in error);
      assert.equal(error.name, "AggregateError");
      assert.ok("errors" in error && Array.isArray(error.errors));
      assert.equal(error.errors.length, 2);
      assert.strictEqual(error.errors[0], workError);
      assert.strictEqual(error.errors[1], releaseError);
      assert.ok("message" in error);
      assert.equal(error.message, "Lock work and its release failed");
      return true;
    },
  );
});

test("redisLock binds the lock contract over the commands its requirements resolve", async () => {
  const redis = fakeRedis();
  const client = unit({ factory: () => redis });
  const settings = unit({ factory: () => ({ prefix: "app" }) });
  const binding = redisLock({
    requirements: { client, settings },
    commands: ({ client }) => client,
    prefix: ({ settings }) => settings.prefix,
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([client, binding])] }), { stopOn: [] });
  try {
    const held = await app.withScope((scope) =>
      scope.resolve(lock).tryRun("rebuild", { leaseMs: 1_000 }, async () => [...redis.keys.keys()]),
    );
    assert.deepEqual(held, { acquired: true, value: ["app:rebuild"] });
    assert.equal(redis.keys.size, 0);
  } finally {
    await app.stop();
  }
});
