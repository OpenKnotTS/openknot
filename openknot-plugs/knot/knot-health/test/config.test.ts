import { nodeHealthMiddleware } from "../src/index.ts";
import { nodeHttpServer } from "@openknot-ts/knot-http-node";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import type { RequestListener } from "node:http";
import { test } from "node:test";
import { z } from "zod";

test("each probe adapter selects its own validated paths without loading default env", async () => {
  const settings = config({ PROBE_PREFIX: z.string().startsWith("/") });
  const middleware = nodeHealthMiddleware({
    requirements: { settings },
    paths: ({ settings }) => ({
      liveness: `${settings.PROBE_PREFIX}/live`,
      readiness: `${settings.PROBE_PREFIX}/ready`,
      health: `${settings.PROBE_PREFIX}/health`,
    }),
  });
  const handler = unit({ factory: (): RequestListener => (_req, response) => response.writeHead(404).end() });
  const server = nodeHttpServer({ handler });
  const definition = defineApplication({ modules: [providePlugs([server, middleware])] });
  const env = { PORT: "0", PROBE_PREFIX: "/custom", HTTP_LIVENESS_PATH: "unused" };
  await assert.rejects(
    runApplication(definition, { env: { ...env, PROBE_PREFIX: "invalid" }, stopOn: [] }),
    /PROBE_PREFIX/,
  );
  const app = await runApplication(definition, { env, stopOn: [] });
  try {
    const url = app.resolve(server).url;
    for (const path of ["live", "ready", "health"]) {
      const response = await fetch(`${url}/custom/${path}`);
      assert.deepEqual([response.status, await response.json()], [200, { status: "up" }]);
    }
    assert.equal((await fetch(`${url}/livez`)).status, 404);
  } finally {
    await app.stop();
  }
});
