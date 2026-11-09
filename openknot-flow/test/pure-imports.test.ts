import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

const script = `
import { registerHooks } from "node:module";
const resolved = [];
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    resolved.push(result.url);
    return result;
  },
});
await import("@openknot-ts/behavior");
await import("@openknot-ts/flow");
console.log(JSON.stringify(resolved));
`;

test("the plain Behavior and Flow entries load only Wire's small helpers, never its container", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
  });
  const wire = (JSON.parse(stdout) as string[])
    .filter((url) => url.includes("/openknot-wire/"))
    .map((url) => url.slice(url.indexOf("/openknot-wire/")));

  assert.ok(wire.length > 0);
  assert.deepEqual(
    wire.filter((url) => !/\/dist\/internal\/(marker|requirements|synchronous)\.js$/.test(url)),
    [],
  );
});
