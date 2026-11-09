import type { HttpHandler } from "../src/index.ts";
import { bunHttpServer } from "../src/index.ts";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";

test("native options callbacks map validated config for multiple Bun hosts without default HTTP config", async () => {
  const settings = config({
    API_PORT: z.coerce.number().int().min(0).max(65_535),
    ADMIN_PORT: z.coerce.number().int().min(0).max(65_535),
    API_HOST: z.string(),
    API_IDLE: z.coerce.number().int().min(0).max(255),
  });
  let built = 0;
  const handler = unit({
    factory: (): HttpHandler => {
      built++;
      return () => new Response("custom");
    },
  });
  const host = (port: "API_PORT" | "ADMIN_PORT") =>
    bunHttpServer({
      handler,
      requirements: { settings },
      options: ({ settings }) => ({
        port: settings[port],
        hostname: settings.API_HOST,
        idleTimeout: settings.API_IDLE,
        routes: { "/native": new Response("route") },
      }),
    });
  const api = host("API_PORT");
  const admin = host("ADMIN_PORT");
  const application = defineApplication({ modules: [providePlugs([api, admin])] });
  const env = {
    API_PORT: "0",
    ADMIN_PORT: "0",
    API_HOST: "127.0.0.1",
    API_IDLE: "0",
    PORT: "unused",
    HTTP_HOST: "",
    HTTP_IDLE_TIMEOUT_SECONDS: "unused",
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
    for (const value of [first, second]) {
      assert.equal(value.native.hostname, "127.0.0.1");
      const fallback = await fetch(value.url);
      assert.deepEqual([fallback.status, await fallback.text()], [200, "custom"]);
      const native = await fetch(new URL("/native", value.url));
      assert.deepEqual([native.status, await native.text()], [200, "route"]);
    }
  } finally {
    await app.stop();
  }
  assert.equal(first.listening, false);
  assert.equal(second.listening, false);
});
