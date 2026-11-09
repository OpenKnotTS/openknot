import { bunHealthMiddleware, healthHttp } from "../src/index.ts";
import { healthCheck } from "@openknot-ts/health";
import { http, httpServer } from "@openknot-ts/knot-http-bun";
import type { HttpHandler } from "@openknot-ts/knot-http-bun/handler";
import { httpHandler } from "@openknot-ts/knot-http-bun/handler";
import { config, providePlugs, composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";

test("the Bun adapter answers probes before the fallback handler and leaves other requests to it", async () => {
  let databaseUp = true;
  const handler = unit({ provides: httpHandler, factory: (): HttpHandler => () => new Response("app") });
  const databaseHealth = healthCheck({ name: "database", check: async () => (databaseUp ? "up" : "down") });
  const app = await runApplication(
    defineApplication({ modules: [http, healthHttp, composeModule({ providers: { handler, databaseHealth } })] }),
    { env: { PORT: "0", HTTP_READINESS_PATH: "/ready" }, stopOn: [] },
  );
  try {
    const url = app.resolve(httpServer).url;
    const request = async (path: string, method = "GET") => {
      const response = await fetch(new URL(path, url), { method });
      return [response.status, response.headers.get("cache-control"), await response.text()];
    };
    assert.deepEqual(await request("/livez"), [200, "no-store", '{"status":"up"}']);
    assert.deepEqual(await request("/ready?probe=1"), [200, "no-store", '{"status":"up"}']);
    assert.deepEqual(await request("/health", "HEAD"), [200, "no-store", ""]);
    databaseUp = false;
    assert.deepEqual(await request("/health"), [503, "no-store", '{"status":"down"}']);
    assert.deepEqual(await request("/ready"), [200, "no-store", '{"status":"up"}']);
    assert.deepEqual(await request("/readyz"), [200, null, "app"]);
    assert.deepEqual(await request("/health", "POST"), [200, null, "app"]);
  } finally {
    await app.stop();
  }
});

test("custom probe paths omit default env on Bun", async () => {
  const settings = config({ PREFIX: z.string().startsWith("/") });
  const middleware = bunHealthMiddleware({
    requirements: { settings },
    paths: ({ settings }) => ({
      liveness: settings.PREFIX + "/live",
      readiness: settings.PREFIX + "/ready",
      health: settings.PREFIX + "/health",
    }),
  });
  const handler = unit({
    provides: httpHandler,
    factory: (): HttpHandler => () => new Response("app", { status: 404 }),
  });
  const app = await runApplication(defineApplication({ modules: [http, providePlugs([middleware, handler])] }), {
    env: { PORT: "0", PREFIX: "/native", HTTP_HEALTH_PATH: "unused" },
    stopOn: [],
  });
  try {
    const response = await fetch(new URL("/native/health", app.resolve(httpServer).url));
    assert.deepEqual([response.status, await response.json()], [200, { status: "up" }]);
    assert.equal((await fetch(new URL("/health", app.resolve(httpServer).url))).status, 404);
  } finally {
    await app.stop();
  }
});

test("disconnecting a health request cancels its pending checks on Bun", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const slow = healthCheck({
    name: "slow",
    // Far beyond the test's timeout: only the client's disconnect can end this check in time.
    timeoutMs: 60_000,
    check: async (_dependencies, { signal }) => {
      entered.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      cancelled.resolve();
      return "down";
    },
  });
  const handler = unit({ provides: httpHandler, factory: (): HttpHandler => () => new Response("app") });
  const app = await runApplication(
    defineApplication({ modules: [http, healthHttp, composeModule({ providers: { handler, slow } })] }),
    { env: { PORT: "0" }, stopOn: [] },
  );
  const controller = new AbortController();
  try {
    const pending = fetch(new URL("/health", app.resolve(httpServer).url), { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await cancelled.promise;
  } finally {
    controller.abort();
    await app.stop();
  }
}, 5_000);
