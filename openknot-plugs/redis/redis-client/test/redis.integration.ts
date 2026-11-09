import { redisClient, redisHealthCheck } from "../src/index.ts";
import { health, healthProbes } from "@openknot-ts/health";
import { composeModule, defineApplication, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "redis";

const url = process.env.REDIS_URL ?? "";
const skip = url === "" ? "set REDIS_URL to run against Redis" : false;

test(
  "a real server is connected at startup, reports up and both clients close on stop",
  { skip, timeout: 10_000 },
  async () => {
    const created: { readonly isOpen: boolean }[] = [];
    const redis = redisClient({
      create: () => {
        const commands = createClient({ url });
        const subscriber = createClient({ url });
        created.push(commands, subscriber);
        return { commands, subscriber };
      },
    });
    const app = await runApplication(
      defineApplication({
        modules: [health, composeModule({ providers: { redis, check: redisHealthCheck({ redis }) } })],
      }),
      { stopOn: [] },
    );
    try {
      const report = await app.resolve(healthProbes).health({ signal: new AbortController().signal });
      assert.equal(report.status, "up");
    } finally {
      await app.stop();
    }
    assert.deepEqual(
      created.map((client) => client.isOpen),
      [false, false],
    );
  },
);
