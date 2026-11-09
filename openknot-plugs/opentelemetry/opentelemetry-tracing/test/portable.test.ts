import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("the built integration imports and executes with only the API, without an SDK or Wire installed", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "openknot-otel-api-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const destination = join(folder, "node_modules/@openknot-ts/opentelemetry-tracing");
  await mkdir(destination, { recursive: true });
  await cp(join(root, "package.json"), join(destination, "package.json"));
  await cp(join(root, "dist"), join(destination, "dist"), { recursive: true });
  await mkdir(join(folder, "node_modules/@opentelemetry"));
  await symlink(join(root, "node_modules/@opentelemetry/api"), join(folder, "node_modules/@opentelemetry/api"), "dir");
  await writeFile(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  const source = `
import assert from "node:assert/strict";
import { trace, ROOT_CONTEXT } from "@opentelemetry/api";
import { openTelemetryTracing } from "@openknot-ts/opentelemetry-tracing";
const tracing = openTelemetryTracing({
  tracer: trace.getTracer("consumer"),
  propagator: { fields: () => [], inject() {}, extract: () => ROOT_CONTEXT },
});
assert.equal(await tracing.run({ name: "openknot.command" }, async () => 42), 42);
assert.equal(tracing.capture(), undefined);
console.log("api-only");
`;
  await writeFile(join(folder, "consumer.js"), source);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, [join(folder, "consumer.js")], {
    cwd: folder,
    env: environment,
  });
  assert.equal(stdout.trim(), "api-only");
});
