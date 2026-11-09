import { nodeHttpServer } from "../src/index.ts";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

test("custom listen maps validated config for two hosts without loading default HTTP config", async () => {
  const settings = config({
    API_PORT: z.coerce.number().int().min(0).max(65_535),
    ADMIN_PORT: z.coerce.number().int().min(0).max(65_535),
    API_HOST: z.string(),
    REQUEST_MS: z.coerce.number().int().positive(),
  });
  let built = 0;
  const handler = unit({
    factory: (): RequestListener => {
      built++;
      return (_request, response) => {
        response.end("custom");
      };
    },
  });
  const host = (port: "API_PORT" | "ADMIN_PORT") =>
    nodeHttpServer({
      handler,
      requirements: { settings },
      options: ({ settings }) => ({ requestTimeout: settings.REQUEST_MS, keepAliveTimeout: 1_234 }),
      listen: ({ settings }) => ({ port: settings[port], host: settings.API_HOST, backlog: 16 }),
    });
  const api = host("API_PORT");
  const admin = host("ADMIN_PORT");
  const application = defineApplication({ modules: [providePlugs([api, admin])] });
  const env = {
    API_PORT: "0",
    ADMIN_PORT: "0",
    API_HOST: "127.0.0.1",
    REQUEST_MS: "23456",
    PORT: "unused",
    HTTP_HOST: "",
    HTTP_REQUEST_TIMEOUT_MS: "unused",
  };
  await assert.rejects(
    runApplication(application, { env: { ...env, API_PORT: "70000" }, stopOn: [] }).then((app) => app.stop()),
    /API_PORT/,
  );
  assert.equal(built, 0);
  const app = await runApplication(application, { env, stopOn: [] });
  const first = app.resolve(api);
  const second = app.resolve(admin);
  try {
    assert.notEqual(first.url, second.url);
    for (const server of [first, second]) {
      assert.equal(server.native.requestTimeout, 23_456);
      assert.equal(server.native.keepAliveTimeout, 1_234);
      const response = await fetch(server.url);
      assert.deepEqual([response.status, await response.text()], [200, "custom"]);
    }
  } finally {
    await app.stop();
  }
  assert.equal(first.listening, false);
  assert.equal(second.listening, false);
});

test("constructor requirements do not replace the default listen when no override was supplied", async () => {
  const settings = config({ REQUEST_MS: z.coerce.number().int().positive() });
  const handler = unit({
    factory: (): RequestListener => (_request, response) => {
      response.end("default");
    },
  });
  const server = nodeHttpServer({
    handler,
    requirements: { httpConfig: settings },
    options: ({ httpConfig }) => ({ requestTimeout: httpConfig.REQUEST_MS }),
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), {
    env: { PORT: "0", REQUEST_MS: "12345" },
    stopOn: [],
  });
  try {
    const value = app.resolve(server);
    assert.equal(value.native.requestTimeout, 12_345);
    assert.match(value.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await (await fetch(value.url)).text(), "default");
  } finally {
    await app.stop();
  }
});

test("custom listen keeps native Unix socket and signal semantics through shutdown", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openknot-node-listen-"));
  const socketPath = join(directory, "server.sock");
  const controller = new AbortController();
  const handler = unit({
    factory: (): RequestListener => (_request, response) => {
      response.end("socket");
    },
  });
  const server = nodeHttpServer({
    handler,
    listen: () => ({ path: socketPath, signal: controller.signal }),
  });
  try {
    const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), {
      env: { PORT: "unused", HTTP_HOST: "" },
      stopOn: [],
    });
    try {
      const value = app.resolve(server);
      assert.equal(value.url, socketPath);
      const body = await new Promise<string>((resolve, reject) => {
        const client = request({ socketPath, path: "/" }, (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
          });
          response.once("error", reject);
          response.once("end", () => resolve(text));
        });
        client.once("error", reject);
        client.end();
      });
      assert.equal(body, "socket");
      const closed = once(value.native, "close");
      controller.abort();
      await closed;
      assert.equal(value.listening, false);
    } finally {
      await app.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
