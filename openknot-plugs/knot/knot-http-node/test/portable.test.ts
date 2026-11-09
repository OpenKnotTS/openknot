import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the public HTTP host loads without any health package", async () => {
  const source = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    assert.equal(specifier.startsWith("@openknot-ts/health"), false);
    assert.equal(specifier.startsWith("@openknot-ts/knot-health"), false);
    return nextResolve(specifier, context);
  },
});
const host = await import("@openknot-ts/knot-http-node");
assert.equal(typeof host.nodeHttpServer, "function");
assert.equal(typeof host.http, "object");
`;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment,
  });
});
