import { fastifyHealthPlugin, healthHttp } from "../src/fastify.ts";
import type { FastifyPlugin } from "@openknot-ts/fastify-server";
import { fastifyHttp, fastifyPlugins, fastifyServer } from "@openknot-ts/fastify-server";
import { healthCheck } from "@openknot-ts/health";
import { config, providePlugs, composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

test("the Fastify adapter answers probes beside the application's routes and leaves other requests to them", async () => {
  let databaseUp = true;
  const routes = unit({
    provides: fastifyPlugins,
    factory: (): FastifyPlugin => async (instance) => {
      instance.all("/readyz", async () => "app");
    },
  });
  const databaseHealth = healthCheck({ name: "database", check: async () => (databaseUp ? "up" : "down") });
  const app = await runApplication(
    defineApplication({ modules: [fastifyHttp, healthHttp, composeModule({ providers: { routes, databaseHealth } })] }),
    { env: { PORT: "0", HTTP_READINESS_PATH: "/ready" }, stopOn: [] },
  );
  try {
    const url = app.resolve(fastifyServer).url;
    const request = async (path: string, method = "GET") => {
      const response = await fetch(`${url}${path}`, { method });
      return [response.status, response.headers.get("cache-control"), await response.text()];
    };
    assert.deepEqual(await request("/livez"), [200, "no-store", '{"status":"up"}']);
    assert.deepEqual(await request("/ready?probe=1"), [200, "no-store", '{"status":"up"}']);
    assert.deepEqual(await request("/health", "HEAD"), [200, "no-store", ""]);
    databaseUp = false;
    assert.deepEqual(await request("/health"), [503, "no-store", '{"status":"down"}']);
    assert.deepEqual(await request("/ready"), [200, "no-store", '{"status":"up"}']);
    assert.deepEqual(await request("/readyz"), [200, null, "app"]);
    assert.equal((await fetch(`${url}/health`, { method: "POST" })).status, 404);
  } finally {
    await app.stop();
  }
});

test("custom probe paths omit default env on Fastify", async () => {
  const settings = config({ PREFIX: z.string().startsWith("/") });
  const plugin = fastifyHealthPlugin({
    requirements: { settings },
    paths: ({ settings }) => ({
      liveness: settings.PREFIX + "/live",
      readiness: settings.PREFIX + "/ready",
      health: settings.PREFIX + "/health",
    }),
  });
  const app = await runApplication(defineApplication({ modules: [fastifyHttp, providePlugs([plugin])] }), {
    env: { PORT: "0", PREFIX: "/native", HTTP_HEALTH_PATH: "unused" },
    stopOn: [],
  });
  try {
    const response = await fetch(app.resolve(fastifyServer).url + "/native/health");
    assert.deepEqual([response.status, await response.json()], [200, { status: "up" }]);
    assert.equal((await fetch(app.resolve(fastifyServer).url + "/health")).status, 404);
  } finally {
    await app.stop();
  }
});
