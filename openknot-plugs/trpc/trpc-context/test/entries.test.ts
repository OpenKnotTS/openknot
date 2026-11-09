import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the context package runs without routers, a host or a transport adapter", async () => {
  const source = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const prefix of ["@trpc/server/adapters/", "@openknot-ts/trpc-router", "@openknot-ts/knot-http-node", "@openknot-ts/trpc-knot-server-handler", "fastify"]) {
      assert.equal(specifier.startsWith(prefix), false, specifier);
    }
    return nextResolve(specifier, context);
  },
});
const core = await import("@openknot-ts/trpc-context");
const wire = await import("@openknot-ts/trpc-context/wire");
const { defineApplication, runApplication } = await import("@openknot-ts/wire");
assert.equal(typeof core.createTrpcContext, "function");
assert.equal(typeof wire.trpcContext, "object");
const app = await runApplication(defineApplication({ modules: [wire.trpcContext] }));
try {
  const context = await app.resolve(wire.trpcContextFactory)({ req: { headers: {} }, info: { signal: new AbortController().signal } });
  assert.deepEqual(context.propagation, {});
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
