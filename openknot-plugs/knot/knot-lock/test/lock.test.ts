import { knotLock } from "../src/index.ts";
import { inProcessLock } from "../src/wire.ts";
import { lock } from "@openknot-ts/lock/wire";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("a second caller does not wait and acquires after release", async () => {
  const lock = knotLock();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = lock.tryRun("rebuild", { leaseMs: 60_000 }, async () => {
    await held;
    return "first";
  });
  assert.deepEqual(await lock.tryRun("rebuild", { leaseMs: 60_000 }, async () => "second"), { acquired: false });
  release();
  assert.deepEqual(await first, { acquired: true, value: "first" });
  assert.deepEqual(await lock.tryRun("rebuild", { leaseMs: 60_000 }, async () => "third"), {
    acquired: true,
    value: "third",
  });
});

test("an expired lease lets another caller in and the old holder does not release it", async () => {
  let clock = 0;
  const lock = knotLock({ now: () => clock });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tokens: string[] = [];
  const first = lock.tryRun("rebuild", { leaseMs: 10 }, async ({ token }) => {
    tokens.push(token);
    await held;
  });
  clock = 11;
  let releaseSecond: () => void = () => undefined;
  const second = lock.tryRun("rebuild", { leaseMs: 10 }, async ({ token }) => {
    tokens.push(token);
    await new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
  });
  release();
  await first;
  assert.deepEqual(await lock.tryRun("rebuild", { leaseMs: 10 }, async () => undefined), { acquired: false });
  releaseSecond();
  await second;
  assert.notEqual(tokens[0], tokens[1]);
});

test("inProcessLock binds the lock contract an application requires", async () => {
  const app = await runApplication(defineApplication({ modules: [providePlugs([inProcessLock])] }), { stopOn: [] });
  try {
    const result = await app.withScope((scope) =>
      scope.resolve(lock).tryRun("rebuild", { leaseMs: 1_000 }, async () => "ran"),
    );
    assert.deepEqual(result, { acquired: true, value: "ran" });
  } finally {
    await app.stop();
  }
});
