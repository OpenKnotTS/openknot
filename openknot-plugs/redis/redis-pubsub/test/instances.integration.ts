import { redisTopic, SubscriptionLostError } from "../src/index.ts";
import { topic } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { redisClient } from "@openknot-ts/redis-client";
import { defineApplication, plug, providePlugs, resource, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createClient } from "redis";

const url = process.env.REDIS_URL ?? "";
const skip = url === "" ? "set REDIS_URL to run against Redis" : false;

type RoleChanged = { readonly roleId: string; readonly name: string };
const roles = topic<string, RoleChanged>()({});

async function instance(run: string, name: string) {
  const redis = redisClient({
    create: () => ({
      commands: createClient({ url }),
      subscriber: createClient({ url, name: `${run}-${name}-subscriber` }),
    }),
  });
  const roleDelivery = resource({
    requirements: { redis },
    initialize: ({ redis }) =>
      redisTopic<string, RoleChanged>({
        commands: redis.commands,
        subscriber: redis.subscriber,
        connection: redis.connection.subscriber,
        channel: (roleId) => `${run}:roles:${roleId}`,
      }),
  });
  const roleBinding = plug({ port: roles, requirements: { roleDelivery }, bind: ({ roleDelivery }) => roleDelivery });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([roles]), providePlugs([redis, roleDelivery, roleBinding])] }),
    { stopOn: [] },
  );
  return { app, redis: app.resolve(redis) };
}

async function subscribe(app: Awaited<ReturnType<typeof instance>>["app"], roleId: string) {
  return (await app.resolve(roles).subscribe({ input: roleId }))[Symbol.asyncIterator]();
}

test(
  "an event published on one instance reaches its key's subscribers on another instance only",
  { skip },
  async () => {
    const run = `openknot-test:${randomUUID()}`;
    const a = await instance(run, "a");
    const b = await instance(run, "b");
    try {
      const dispatcher = await subscribe(b.app, "dispatcher");
      const auditor = await subscribe(b.app, "auditor");
      await a.app.resolve(roles).publish("dispatcher", { roleId: "dispatcher", name: "Dispatcher" });
      await a.app.resolve(roles).publish("auditor", { roleId: "auditor", name: "Auditor" });
      assert.deepEqual((await dispatcher.next()).value, { roleId: "dispatcher", name: "Dispatcher" });
      assert.deepEqual((await auditor.next()).value, { roleId: "auditor", name: "Auditor" });
    } finally {
      await Promise.all([a.app.stop(), b.app.stop()]);
    }
  },
);

test(
  "a dropped subscriber connection ends the instance's subscriptions, and once it is back they deliver again",
  { skip, timeout: 20_000 },
  async () => {
    const run = `openknot-test:${randomUUID()}`;
    const a = await instance(run, "a");
    const b = await instance(run, "b");
    try {
      const dispatcher = await subscribe(b.app, "dispatcher");
      const ended = assert.rejects(dispatcher.next(), SubscriptionLostError.is);
      const lost = Promise.withResolvers<void>();
      const restored = Promise.withResolvers<void>();
      const unwatch = b.redis.connection.subscriber.watch({ lost: lost.resolve, restored: restored.resolve });
      const clients = String(await a.redis.commands.sendCommand(["CLIENT", "LIST", "TYPE", "pubsub"]));
      const id = /id=(\d+) .*name=(\S+)/
        .exec(clients.split("\n").find((line) => line.includes(`name=${run}-b-subscriber`)) ?? "")
        ?.at(1);
      assert.ok(id, "instance b's subscriber is a pub/sub client");
      await a.redis.commands.sendCommand(["CLIENT", "KILL", "ID", id]);
      await lost.promise;
      await ended;
      await restored.promise;
      unwatch();

      const again = await subscribe(b.app, "dispatcher");
      await a.app.resolve(roles).publish("dispatcher", { roleId: "dispatcher", name: "Restored" });
      assert.deepEqual((await again.next()).value, { roleId: "dispatcher", name: "Restored" });
    } finally {
      await Promise.all([a.app.stop(), b.app.stop()]);
    }
  },
);
