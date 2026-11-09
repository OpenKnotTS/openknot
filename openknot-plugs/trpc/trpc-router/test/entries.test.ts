import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the router package runs without a host or transport adapter", async () => {
  const source = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const prefix of ["@trpc/server/adapters/", "@openknot-ts/knot-http-node", "@openknot-ts/trpc-knot-server-handler", "fastify"]) {
      assert.equal(specifier.startsWith(prefix), false, specifier);
    }
    return nextResolve(specifier, context);
  },
});
const wire = await import("@openknot-ts/trpc-router");
const { defineApplication, providePlugs, runApplication } = await import("@openknot-ts/wire");
assert.equal(typeof wire.trpcRouter, "function");
assert.equal("trpcHandler" in wire, false);
assert.equal("trpcHttpConfig" in wire, false);
const router = wire.trpcRouter({ routes: ({ trpc }) => ({ ping: trpc.procedure.query(() => "core") }) });
const app = await runApplication(defineApplication({ modules: [providePlugs([router, wire.trpcRootRouter])] }), {
  env: { PORT: "unused", TRPC_BASE_PATH: "unused", TRPC_MAX_BODY_SIZE: "unused" },
});
try {
  const api = app.resolve(wire.trpcRootRouter).createCaller({
    actor: undefined, signal: new AbortController().signal, propagation: {},
    authenticate: async () => undefined,
  });
  assert.equal(await api.ping(), "core");
} finally {
  await app.stop();
}
`;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const { stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment,
  });
  assert.equal(stderr, "");
});
