import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));

test("the built package emits portable consumer declarations and runs without tRPC or ws installed", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "openknot-knot-pubsub-consumer-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const modules = join(folder, "node_modules");
  await mkdir(join(modules, "@openknot-ts"), { recursive: true });
  for (const [name, path] of [
    ["wire", "openknot-wire"],
    ["behavior", "openknot-behavior"],
    ["flow", "openknot-flow"],
    ["tracing", "openknot-capabilities/tracing"],
    ["versioning", "openknot-capabilities/versioning"],
    ["knot-pubsub", "openknot-plugs/knot/knot-pubsub"],
  ] as const) {
    const source = join(workspace, path);
    const destination = join(modules, "@openknot-ts", name);
    await mkdir(destination);
    await cp(join(source, "package.json"), join(destination, "package.json"));
    await cp(join(source, "dist"), join(destination, "dist"), { recursive: true });
  }
  for (const [name, source] of [
    ["@types/node", "openknot-wire/node_modules/@types/node"],
    ["@standard-schema/spec", "openknot-behavior/node_modules/@standard-schema/spec"],
  ]) {
    const destination = join(modules, name!);
    await mkdir(join(destination, ".."), { recursive: true });
    await symlink(join(workspace, source!), destination, "dir");
  }
  await writeFile(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(folder, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        declaration: true,
        types: ["node"],
        outDir: "out",
      },
      include: ["consumer.ts"],
    }),
  );
  await writeFile(
    join(folder, "consumer.ts"),
    `
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { topic } from "@openknot-ts/flow";
import { reader } from "@openknot-ts/behavior";
import { defineApplication, plug, providePlugs, resource, runApplication } from "@openknot-ts/wire";
import { inMemoryTopic } from "@openknot-ts/knot-pubsub";
export function bindings(events: EventEmitter) {
  const changes = topic<{ readonly roleId: number }, string>()({});
  const delivery = resource({ initialize: () => inMemoryTopic<{ readonly roleId: number }, string>({
    events, event: (key) => String(key.roleId),
  }) });
  const output = plug({ port: changes, requirements: { delivery }, bind: ({ delivery }) => delivery });
  const length = reader<(id: string) => number>();
  const label = reader<() => string>();
  const queries = reader.compose({ length, label });
  const reading = plug({
    port: queries,
    bind: () => ({
      length: (id) => id.length,
      label: () => "Dispatcher",
    }),
  });
  return { changes, delivery, output, length, label, reading };
}
const events = new EventEmitter();
const { changes, delivery, output, length, label, reading } = bindings(events);
const app = await runApplication(defineApplication({
  modules: [providePlugs([delivery, output, reading])],
}));
try {
  const messages = (await app.resolve(changes).subscribe({ input: { roleId: 1 } }))[Symbol.asyncIterator]();
  await app.resolve(changes).publish({ roleId: 1 }, "changed");
  assert.deepEqual(await messages.next(), { done: false, value: "changed" });
  await app.withScope((scope) => {
    assert.equal(scope.resolve(length)("role"), 4);
    assert.equal(scope.resolve(label)(), "Dispatcher");
  });
} finally { await app.stop(); }
assert.deepEqual(events.eventNames(), []);
`,
  );
  const compiler = join(workspace, "openknot-plugs/knot/knot-pubsub/node_modules/typescript/bin/tsc");
  try {
    await exec(process.execPath, [compiler, "-p", join(folder, "tsconfig.json")], { cwd: folder });
    await exec(process.execPath, [join(folder, "out/consumer.js")], { cwd: folder });
  } catch (error) {
    assert.fail(
      error instanceof Error && "stdout" in error
        ? `${error.message}\n${error.stdout}\n${"stderr" in error ? error.stderr : ""}`
        : String(error),
    );
  }
});
