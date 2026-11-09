import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the public adapter composes with the shared core and Knot host without other adapters", async () => {
  const source = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const prefix of ["fastify", "@trpc/server/adapters/fastify", "@openknot-ts/health", "@openknot-ts/knot-health"]) {
      assert.equal(specifier.startsWith(prefix), false, specifier);
    }
    return nextResolve(specifier, context);
  },
});
const { trpcHttp } = await import("@openknot-ts/trpc-knot-server-handler");
const { trpcRouter } = await import("@openknot-ts/trpc-router");
const { http, httpServer } = await import("@openknot-ts/knot-http-node");
const { defineApplication, providePlugs, runApplication } = await import("@openknot-ts/wire");
const router = trpcRouter({ routes: ({ trpc }) => ({ ping: trpc.procedure.query(() => "pong") }) });
const app = await runApplication(defineApplication({ modules: [http, trpcHttp, providePlugs([router])] }), {
  env: { PORT: "0" },
});
const server = app.resolve(httpServer);
try {
  const response = await fetch(server.url + "/trpc/ping");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: { data: "pong" } });
} finally {
  await app.stop();
}
assert.equal(server.listening, false);
`;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const { stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment,
    timeout: 10_000,
  });
  assert.equal(stderr, "");
});
