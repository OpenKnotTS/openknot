import { rabbitTopology } from "../src/index.ts";
import { rabbitConfig } from "../src/setup/connection.ts";
import { success } from "@openknot-ts/behavior";
import { listener } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";

test("managed RMQ rejects invalid URLs and numeric settings at startup", async () => {
  const application = defineApplication({ modules: [providePlugs([rabbitConfig])] });
  const options = { stopOn: [] } as const;
  for (const RABBITMQ_URL of [undefined, "", "http://localhost:5672", "invalid", "amqp://[", "amqps://["]) {
    await assert.rejects(runApplication(application, { ...options, env: { RABBITMQ_URL } }), /RABBITMQ_URL/);
  }
  for (const name of ["RABBITMQ_STARTUP_TIMEOUT_MS", "RABBITMQ_HEARTBEAT_SECONDS", "RABBITMQ_ACQUIRE_TIMEOUT_MS"]) {
    for (const value of ["", " ", "-1", "+1", "1.5", "1e3", "0x10", "Infinity", "NaN", "9007199254740992"]) {
      await assert.rejects(
        runApplication(application, { ...options, env: { RABBITMQ_URL: "amqp://localhost:5672", [name]: value } }),
        new RegExp(name),
      );
    }
  }
  for (const name of ["RABBITMQ_STARTUP_TIMEOUT_MS", "RABBITMQ_ACQUIRE_TIMEOUT_MS"]) {
    await assert.rejects(
      runApplication(application, { ...options, env: { RABBITMQ_URL: "amqp://localhost:5672", [name]: "0" } }),
      new RegExp(name),
    );
  }
});

test("managed RMQ resolves defaults, heartbeat zero and safe integer boundaries from the environment", async () => {
  const application = defineApplication({ modules: [providePlugs([rabbitConfig])] });
  for (const { env, expected } of [
    {
      env: { RABBITMQ_URL: "amqp://localhost:5672" },
      expected: {
        RABBITMQ_URL: "amqp://localhost:5672",
        RABBITMQ_STARTUP_TIMEOUT_MS: 10_000,
        RABBITMQ_HEARTBEAT_SECONDS: 60,
        RABBITMQ_ACQUIRE_TIMEOUT_MS: 20_000,
      },
    },
    {
      env: {
        RABBITMQ_URL: "amqps://guest:guest@localhost:5671/%2F",
        RABBITMQ_STARTUP_TIMEOUT_MS: "1",
        RABBITMQ_HEARTBEAT_SECONDS: "0",
        RABBITMQ_ACQUIRE_TIMEOUT_MS: "1",
      },
      expected: {
        RABBITMQ_URL: "amqps://guest:guest@localhost:5671/%2F",
        RABBITMQ_STARTUP_TIMEOUT_MS: 1,
        RABBITMQ_HEARTBEAT_SECONDS: 0,
        RABBITMQ_ACQUIRE_TIMEOUT_MS: 1,
      },
    },
    {
      env: {
        RABBITMQ_URL: "amqp://localhost:5672",
        RABBITMQ_STARTUP_TIMEOUT_MS: "00042",
        RABBITMQ_HEARTBEAT_SECONDS: "9007199254740991",
        RABBITMQ_ACQUIRE_TIMEOUT_MS: "2147483647",
      },
      expected: {
        RABBITMQ_URL: "amqp://localhost:5672",
        RABBITMQ_STARTUP_TIMEOUT_MS: 42,
        RABBITMQ_HEARTBEAT_SECONDS: Number.MAX_SAFE_INTEGER,
        RABBITMQ_ACQUIRE_TIMEOUT_MS: 2_147_483_647,
      },
    },
  ] as const) {
    const app = await runApplication(application, { env, stopOn: [] });
    try {
      assert.deepEqual(app.resolve(rabbitConfig), expected);
    } finally {
      await app.stop();
    }
  }
});

test(
  "cancelling RMQ startup closes the native socket without waiting for its readiness timeout",
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.resume();
      socket.on("close", () => closed.resolve());
      entered.resolve();
    });
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const cancellation = new AbortController();
    const reason = new Error("Cancel managed RMQ startup");
    const received = listener({ run: () => success() });
    const { rabbitListener } = rabbitTopology({ exchanges: [], queues: [{ queue: "test" }], routes: [] });
    const starting = runApplication(
      defineApplication({
        modules: [provideFlow([received]), providePlugs([rabbitListener(received)])],
      }),
      {
        env: { RABBITMQ_URL: `amqp://127.0.0.1:${address.port}`, RABBITMQ_STARTUP_TIMEOUT_MS: "30000" },
        signal: cancellation.signal,
      },
    );
    await entered.promise;
    cancellation.abort(reason);
    await assert.rejects(starting, (error) => error === reason);
    await closed.promise;
  },
);

test("native RabbitMQ timer settings reject overflow and accept the maximum signed 32-bit delay", async () => {
  const application = defineApplication({ modules: [providePlugs([rabbitConfig])] });
  const env = { RABBITMQ_URL: "amqp://localhost:5672" };
  for (const name of ["RABBITMQ_STARTUP_TIMEOUT_MS", "RABBITMQ_ACQUIRE_TIMEOUT_MS"] as const) {
    for (const value of ["2147483648", "9007199254740991"]) {
      await assert.rejects(
        runApplication(application, { env: { ...env, [name]: value }, stopOn: [] }),
        new RegExp(name),
      );
    }
    const app = await runApplication(application, { env: { ...env, [name]: "2147483647" }, stopOn: [] });
    try {
      assert.equal(app.resolve(rabbitConfig)[name], 2_147_483_647);
    } finally {
      await app.stop();
    }
  }
});
