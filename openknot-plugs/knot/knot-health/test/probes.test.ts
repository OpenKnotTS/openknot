import { healthHttp } from "../src/index.ts";
import { health, healthCheck } from "@openknot-ts/health";
import { nodeHttpServer } from "@openknot-ts/knot-http-node";
import { composeModule, defineApplication, hook, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { RequestListener } from "node:http";
import { test } from "node:test";

const env = { PORT: "0" };

async function status(url: string, path: string, method = "GET"): Promise<number> {
  const response = await fetch(`${url}${path}`, { method });
  await response.body?.cancel();
  return response.status;
}

test("the selected adapter serves probes before the application handler across lifecycle changes", async () => {
  let databaseUp = true;
  const readiness: string[] = [];
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.end("app") });
  const server = nodeHttpServer({ handler });
  const databaseHealth = healthCheck({ name: "database", check: async () => (databaseUp ? "up" : "down") });
  const observe = (phase: string) =>
    hook({
      requirements: { server },
      async run({ server }) {
        readiness.push(`${phase}: ${await status(server.url, "/readyz")}`);
      },
    });
  const app = await runApplication(
    defineApplication({
      modules: [healthHttp, composeModule({ providers: { server, databaseHealth } })],
      // Host inputs listen before startup tasks and drain after shutdown tasks.
      startupTasks: [observe("starting")],
      shutdownTasks: [observe("stopping")],
    }),
    { env },
  );
  try {
    const url = app.resolve(server).url;
    const response = await fetch(`${url}/health`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "up" });
    const probes = () => Promise.all(["/livez", "/readyz", "/health?verbose"].map((path) => status(url, path)));
    assert.deepEqual(await probes(), [200, 200, 200]);
    assert.equal(await status(url, "/readyz", "HEAD"), 200);
    const head = await fetch(`${url}/health`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength('{"status":"up"}')));
    assert.equal(await (await fetch(`${url}/readyz`, { method: "POST" })).text(), "app");
    assert.equal(await (await fetch(`${url}/roles`)).text(), "app");
    databaseUp = false;
    // A failing dependency turns health down without withdrawing readiness or restarting the process.
    assert.deepEqual(await probes(), [200, 200, 503]);
  } finally {
    await app.stop();
  }
  assert.deepEqual(readiness, ["starting: 503", "stopping: 503"]);
});

test("the adapter validates its own paths before constructing the application's handler", async () => {
  let constructed = false;
  const handler = unit({
    factory: (): RequestListener => {
      constructed = true;
      return (_request, response) => response.end();
    },
  });
  const server = nodeHttpServer({ handler });
  await assert.rejects(
    runApplication(defineApplication({ modules: [healthHttp, composeModule({ providers: { server } })] }), {
      env: { ...env, HTTP_LIVENESS_PATH: "invalid" },
    }),
    /HTTP_LIVENESS_PATH: must start with/,
  );
  assert.equal(constructed, false);
});

test("disconnecting an HTTP health request cancels its pending checks", { timeout: 5_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const slow = healthCheck({
    name: "slow",
    check: async (_dependencies, { signal }) => {
      entered.resolve();
      await once(signal, "abort");
      cancelled.resolve();
      return "down";
    },
  });
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.writeHead(404).end() });
  const server = nodeHttpServer({ handler });
  const app = await runApplication(
    defineApplication({
      modules: [healthHttp, composeModule({ providers: { server, slow } })],
    }),
    { env },
  );
  const controller = new AbortController();
  try {
    const pending = fetch(`${app.resolve(server).url}/health`, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await cancelled.promise;
  } finally {
    controller.abort();
    await app.stop();
  }
});

test("health core alone exposes no routes, while the selected adapter owns path configuration", async () => {
  const handler = unit({
    factory: (): RequestListener => (_request, response) => response.writeHead(404).end(),
  });
  const server = nodeHttpServer({ handler });
  const plugs = composeModule({ providers: { server } });
  const without = await runApplication(defineApplication({ modules: [plugs, health] }), {
    env: { ...env, HTTP_READINESS_PATH: "ignored-invalid-path" },
  });
  const renamed = await runApplication(defineApplication({ modules: [plugs, healthHttp] }), {
    env: { ...env, HTTP_READINESS_PATH: "/ready" },
  });
  const [plain, custom] = [without.resolve(server), renamed.resolve(server)];
  try {
    assert.equal(await status(plain.url, "/readyz"), 404);
    assert.equal(await status(custom.url, "/ready"), 200);
    assert.equal(await status(custom.url, "/readyz"), 404);
  } finally {
    await Promise.all([without.stop(), renamed.stop()]);
  }
  await assert.rejects(
    runApplication(defineApplication({ modules: [plugs, healthHttp] }), {
      env: { ...env, HTTP_HEALTH_PATH: "/livez" },
    }),
    /must differ/,
  );
  for (const name of ["HTTP_LIVENESS_PATH", "HTTP_READINESS_PATH", "HTTP_HEALTH_PATH"]) {
    for (const value of ["", "health"]) {
      await assert.rejects(
        runApplication(defineApplication({ modules: [plugs, healthHttp] }), {
          env: { ...env, [name]: value },
        }).then((app) => app.stop()),
        new RegExp(`${name}: must start with /`),
      );
    }
  }
});
