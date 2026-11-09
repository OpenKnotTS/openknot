import { redisClient } from "../src/index.ts";
import { redisHealthCheck } from "../src/index.ts";
import type { RedisSubscriber } from "../src/index.ts";
import { health, healthProbes } from "@openknot-ts/health";
import { resource } from "@openknot-ts/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

function clients(log: string[], fail = false) {
  const commandEmitter = new EventEmitter();
  const commands = {
    async sendCommand(_arguments: string[]) {
      return "OK";
    },
    async connect() {
      log.push("commands:connect");
    },
    async close() {
      log.push("commands:close");
    },
    destroy() {
      log.push("commands:destroy");
    },
    applicationProperty: "native" as const,
    on: commandEmitter.on.bind(commandEmitter),
    off: commandEmitter.off.bind(commandEmitter),
  };
  const emitter = new EventEmitter();
  const subscriber = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async subscribe(..._args: Parameters<RedisSubscriber["subscribe"]>) {},
    async unsubscribe(..._args: Parameters<RedisSubscriber["unsubscribe"]>) {},
    async connect() {
      log.push("subscriber:connect");
      if (fail) {
        throw new Error("offline");
      }
    },
    async close() {
      log.push("subscriber:close");
    },
    destroy() {
      log.push("subscriber:destroy");
    },
  };
  return { commands, subscriber };
}
test("a provided native Redis resource is acquired once and retains native types for every consumer", async () => {
  const log: string[] = [];
  const native = clients(log);
  const redis = redisClient({ create: () => native });
  const first = unit({ requirements: { redis }, factory: ({ redis }) => redis.commands.applicationProperty });
  const second = unit({ requirements: { redis }, factory: ({ redis }) => redis });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { first, second } })] }));
  assert.equal(app.resolve(first), "native");
  assert.equal(app.resolve(second), native);
  assert.deepEqual(log, ["commands:connect", "subscriber:connect"]);
  await app.stop();
  assert.equal(log.filter((entry) => entry === "commands:close").length, 1);
  assert.equal(log.filter((entry) => entry === "subscriber:close").length, 1);
});
test("failed Redis acquisition destroys both handed-off native clients", async () => {
  const log: string[] = [];
  const redis = redisClient({ create: () => clients(log, true) });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { redis } })] })),
    /Redis acquisition failed/,
  );
  assert.ok(log.includes("commands:destroy"));
  assert.ok(log.includes("subscriber:destroy"));
});

test("a server that refuses the first connection fails acquisition instead of waiting for a reconnection", async () => {
  const log: string[] = [];
  const native = clients(log);
  const refused = new Error("connect ECONNREFUSED");
  // As node-redis does with its default strategy: it reports the error and keeps reconnecting, so connect never settles.
  native.subscriber.connect = () => {
    log.push("subscriber:connect");
    queueMicrotask(() => native.subscriber.emit("error", refused));
    return new Promise<void>(() => undefined);
  };
  const redis = redisClient({ create: () => native });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { redis } })] })),
    (error) => error instanceof AggregateError && error.errors.includes(refused),
  );
  assert.ok(log.includes("commands:destroy"));
  assert.ok(log.includes("subscriber:destroy"));
});

test("an already cancelled acquisition releases clients that the native factory returned", async () => {
  const log: string[] = [];
  const controller = new AbortController();
  const redis = redisClient({
    create: () => {
      controller.abort();
      return clients(log);
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { redis } })] }), {
      signal: controller.signal,
    }),
  );
  assert.ok(log.includes("commands:destroy"));
  assert.ok(log.includes("subscriber:destroy"));
});

test("connection reports lost once and restored on ready", async () => {
  const log: string[] = [];
  const emitter = new EventEmitter();
  const commands = {
    async sendCommand(_arguments: string[]) {
      return "OK";
    },
    async connect() {
      log.push("commands:connect");
    },
    async close() {
      log.push("commands:close");
    },
    destroy() {
      log.push("commands:destroy");
    },
    applicationProperty: "native" as const,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
  const subscriberEmitter = new EventEmitter();
  const subscriber = {
    on: subscriberEmitter.on.bind(subscriberEmitter),
    off: subscriberEmitter.off.bind(subscriberEmitter),
    async subscribe(..._args: Parameters<RedisSubscriber["subscribe"]>) {},
    async unsubscribe(..._args: Parameters<RedisSubscriber["unsubscribe"]>) {},
    async connect() {
      log.push("subscriber:connect");
    },
    async close() {
      log.push("subscriber:close");
    },
    destroy() {
      log.push("subscriber:destroy");
    },
  };
  const native = { commands, subscriber };
  const redis = redisClient({ create: () => native });
  const connectionUnit = unit({ requirements: { redis }, factory: ({ redis }) => redis.connection });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { redis, connectionUnit } })] }),
  );
  const connection = app.resolve(connectionUnit);
  let lostCount = 0;
  let restoredCount = 0;
  const unsubscribe = connection.watch({
    lost: () => {
      lostCount += 1;
    },
    restored: () => {
      restoredCount += 1;
    },
  });
  try {
    emitter.emit("ready");
    assert.equal(restoredCount, 0);
    emitter.emit("reconnecting");
    emitter.emit("end");
    emitter.emit("ready");
    emitter.emit("ready");
    assert.equal(lostCount, 1);
    assert.equal(restoredCount, 1);
  } finally {
    unsubscribe();
    await app.stop();
  }
  assert.deepEqual(emitter.eventNames(), []);
  emitter.emit("reconnecting");
  emitter.emit("end");
  emitter.emit("ready");
  assert.equal(lostCount, 1);
  assert.equal(restoredCount, 1);
  assert.deepEqual(log, [
    "commands:connect",
    "subscriber:connect",
    "commands:close",
    "subscriber:close",
    "commands:destroy",
    "subscriber:destroy",
  ]);
});

test("unsubscribing twice keeps the other watchers", async () => {
  const log: string[] = [];
  const emitter = new EventEmitter();
  const commands = {
    async sendCommand(_arguments: string[]) {
      return "OK";
    },
    async connect() {
      log.push("commands:connect");
    },
    async close() {
      log.push("commands:close");
    },
    destroy() {
      log.push("commands:destroy");
    },
    applicationProperty: "native" as const,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
  const subscriberEmitter = new EventEmitter();
  const subscriber = {
    on: subscriberEmitter.on.bind(subscriberEmitter),
    off: subscriberEmitter.off.bind(subscriberEmitter),
    async subscribe(..._args: Parameters<RedisSubscriber["subscribe"]>) {},
    async unsubscribe(..._args: Parameters<RedisSubscriber["unsubscribe"]>) {},
    async connect() {
      log.push("subscriber:connect");
    },
    async close() {
      log.push("subscriber:close");
    },
    destroy() {
      log.push("subscriber:destroy");
    },
  };
  const native = { commands, subscriber };
  const redis = redisClient({ create: () => native });
  const connectionUnit = unit({ requirements: { redis }, factory: ({ redis }) => redis.connection });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { redis, connectionUnit } })] }),
  );
  const connection = app.resolve(connectionUnit);

  let lostA = 0;
  let restoredA = 0;
  let lostB = 0;
  let restoredB = 0;
  const unsubA = connection.watch({
    lost: () => {
      lostA += 1;
    },
    restored: () => {
      restoredA += 1;
    },
  });
  const unsubB = connection.watch({
    lost: () => {
      lostB += 1;
    },
    restored: () => {
      restoredB += 1;
    },
  });
  unsubA();
  unsubA();
  emitter.emit("reconnecting");
  emitter.emit("end");
  emitter.emit("ready");
  assert.equal(lostA, 0);
  assert.equal(restoredA, 0);
  assert.equal(lostB, 1);
  assert.equal(restoredB, 1);

  unsubB();
  assert.deepEqual(emitter.eventNames(), []);

  let sharedLost = 0;
  let sharedRestored = 0;
  const sharedLostFn = () => {
    sharedLost += 1;
  };
  const sharedRestoredFn = () => {
    sharedRestored += 1;
  };
  const unsubC = connection.watch({ lost: sharedLostFn, restored: sharedRestoredFn });
  const unsubD = connection.watch({ lost: sharedLostFn, restored: sharedRestoredFn });
  emitter.emit("reconnecting");
  emitter.emit("end");
  emitter.emit("ready");
  assert.equal(sharedLost, 2);
  assert.equal(sharedRestored, 2);

  unsubC();
  const beforeLost = sharedLost;
  const beforeRestored = sharedRestored;
  emitter.emit("reconnecting");
  emitter.emit("end");
  emitter.emit("ready");
  assert.equal(sharedLost, beforeLost + 1);
  assert.equal(sharedRestored, beforeRestored + 1);

  unsubD();
  assert.deepEqual(emitter.eventNames(), []);
  const afterLost = sharedLost;
  const afterRestored = sharedRestored;
  emitter.emit("reconnecting");
  emitter.emit("end");
  emitter.emit("ready");
  assert.equal(sharedLost, afterLost);
  assert.equal(sharedRestored, afterRestored);

  await app.stop();
});

test("the health check is up only for PONG, and its deadline withdraws a PING still waiting", async () => {
  let reply: (signal: AbortSignal | undefined) => Promise<unknown> = async () => "PONG";
  const redis = resource({
    initialize: async () => ({
      value: {
        commands: {
          sendCommand: (_arguments: string[], options?: { readonly abortSignal?: AbortSignal }) =>
            reply(options?.abortSignal),
        },
      },
      release() {},
    }),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        health,
        composeModule({
          providers: {
            redis,
            check: redisHealthCheck({ redis: redis as Parameters<typeof redisHealthCheck>[0]["redis"], timeoutMs: 20 }),
          },
        }),
      ],
    }),
    { stopOn: [] },
  );
  try {
    const status = async () =>
      (await app.resolve(healthProbes).health({ signal: new AbortController().signal })).status;
    assert.equal(await status(), "up");
    reply = async () => "LOADING";
    assert.equal(await status(), "down");
    let withdrawn = false;
    reply = (signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => {
          withdrawn = true;
          reject(signal.reason);
        }),
      );
    assert.equal(await status(), "down");
    assert.equal(withdrawn, true);
  } finally {
    await app.stop();
  }
});
