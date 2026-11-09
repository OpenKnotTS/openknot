import { rabbitClient } from "../src/index.ts";
import { config, defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";
import { Connection } from "rabbitmq-client";
import { z } from "zod";

test(
  "native connection factories validate only their own config and cancel native startup without a default URL",
  { timeout: 5_000 },
  async () => {
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const sockets: Socket[] = [];
    const silent = createServer((socket) => {
      sockets.push(socket);
      socket.resume();
      socket.once("close", () => closed.resolve());
      entered.resolve();
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const address = silent.address();
    assert.ok(address !== null && typeof address === "object");
    const settings = config({ BUS_URL: z.url(), BUS_NAME: z.string() });
    let created = 0;
    const client = rabbitClient({
      requirements: { settings },
      create: ({ settings }) => {
        created++;
        return new Connection({
          url: settings.BUS_URL,
          connectionName: settings.BUS_NAME,
          maxChannels: 32,
          frameMax: 16_384,
          noDelay: false,
        });
      },
    });
    const definition = defineApplication({ modules: [providePlugs([client])] });
    try {
      await assert.rejects(
        runApplication(definition, { env: { BUS_URL: "invalid", BUS_NAME: "custom" }, stopOn: [] }),
        /BUS_URL/,
      );
      assert.equal(created, 0);
      const controller = new AbortController();
      const reason = new Error("stop native bus");
      const starting = runApplication(definition, {
        env: { BUS_URL: `amqp://127.0.0.1:${address.port}`, BUS_NAME: "custom", RABBITMQ_URL: "unused" },
        signal: controller.signal,
        stopOn: [],
      });
      await entered.promise;
      controller.abort(reason);
      await assert.rejects(starting, (error) => error === reason);
      await closed.promise;
      assert.equal(created, 1);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  },
);
