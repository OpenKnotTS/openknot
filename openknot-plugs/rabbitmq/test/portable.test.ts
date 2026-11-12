import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../../../", import.meta.url));

test("the built topology infers routes and queues and emits portable bindings without manual setup", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "openknot-rabbitmq-consumer-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const modules = join(folder, "node_modules");
  await mkdir(join(modules, "@openknot-ts"), { recursive: true });
  for (const [name, path] of [
    ["wire", "openknot-wire"],
    ["behavior", "openknot-behavior"],
    ["flow", "openknot-flow"],
    ["error-reporting", "openknot-capabilities/error-reporting"],
    ["tracing", "openknot-capabilities/tracing"],
    ["logging", "openknot-capabilities/logging"],
    ["versioning", "openknot-capabilities/versioning"],
    ["health", "openknot-capabilities/health"],
    ["rabbitmq", "openknot-plugs/rabbitmq"],
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
    ["rabbitmq-client", "openknot-plugs/rabbitmq/node_modules/rabbitmq-client"],
    ["zod", "openknot-plugs/rabbitmq/node_modules/zod"],
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
        types: ["node"],
        outDir: "out",
      },
      include: ["consumer.ts"],
    }),
  );
  await writeFile(
    join(folder, "consumer.ts"),
    `
import { success } from "@openknot-ts/behavior";
import { listener, publisher } from "@openknot-ts/flow";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import { provideFlow } from "@openknot-ts/flow/wire";
import { rabbitTopology } from "@openknot-ts/rabbitmq";
import type { StandardSchemaV1 } from "@standard-schema/spec";
export const { rabbitListener, rabbitPublisher } = rabbitTopology({
  exchanges: [{ exchange: "roles", type: "topic" }, { exchange: "logs", type: "direct" }],
  queues: [{ queue: "roles.audit" }, { queue: "logs.audit" }],
  routes: [{ exchange: "roles", routingKey: "role.created" }, { exchange: "logs", routingKey: "log.created" }],
  queueBindings: [{ queue: "roles.audit", exchange: "roles", routingKey: "role.*" }],
});
export function bindings() {
  const received = listener<number>()({ run: (input) => success(input) });
  const events = publisher<number>();
  const input = rabbitListener({ queue: "roles.audit", qos: { prefetchCount: 1 }, consumerTag: "typed" }, received);
  const output = rabbitPublisher({ exchange: "roles", routingKey: "role.created" }, events);
  const text: StandardSchemaV1<unknown, string> = {
    "~standard": { version: 1, vendor: "test", validate: () => ({ value: "text" }) },
  };
  // @ts-expect-error A string schema cannot supply a number listener.
  rabbitListener({ queue: "roles.audit", schema: text }, received);
  // @ts-expect-error Unknown queues are rejected.
  rabbitListener({ queue: "missing" }, received);
  // @ts-expect-error The adapter owns acknowledgments.
  rabbitListener({ queue: "roles.audit", noAck: true }, received);
  // @ts-expect-error The adapter owns startup timing.
  rabbitListener({ queue: "roles.audit", lazy: false }, received);
  // @ts-expect-error The adapter owns retry settlement.
  rabbitListener({ queue: "roles.audit", requeue: true }, received);
  // @ts-expect-error Connection is managed.
  rabbitListener({ queue: "roles.audit", connection: {} }, received);
  // @ts-expect-error Exchanges and route keys must belong to the same declared route.
  rabbitPublisher({ exchange: "roles", routingKey: "log.created" }, events);
  // @ts-expect-error Unknown exchanges are rejected.
  rabbitPublisher({ exchange: "missing", routingKey: "role.created" }, events);
  // @ts-expect-error Unknown routing keys are rejected.
  rabbitPublisher({ exchange: "roles", routingKey: "missing" }, events);
  // @ts-expect-error Publisher requires a publisher port.
  rabbitPublisher({ exchange: "roles", routingKey: "role.created" }, received);
  // @ts-expect-error Listener requires a listener port.
  rabbitListener({ queue: "roles.audit" }, events);
  rabbitTopology({
    exchanges: [{ exchange: "roles", type: "topic" }], queues: [{ queue: "roles.audit" }],
    // @ts-expect-error Routes cannot manufacture exchanges.
    routes: [{ exchange: "missing", routingKey: "role.created" }],
  });
  rabbitTopology({
    exchanges: [{ exchange: "roles", type: "topic" }], queues: [{ queue: "roles.audit" }], routes: [],
    // @ts-expect-error Bindings cannot manufacture queues.
    queueBindings: [{ queue: "missing", exchange: "roles", routingKey: "#" }],
  });
  const one = rabbitTopology({
    exchanges: [], queues: [{ queue: "direct" }], routes: [{ exchange: "", routingKey: "direct" }],
  });
  const defaultInput = one.rabbitListener(received);
  const defaultOutput = one.rabbitPublisher(undefined, events);
  const application = defineApplication({
    modules: [provideFlow([received]), providePlugs([input, output])],
  });
  const start = () => runApplication(application);
  return { input, output, defaultInput, defaultOutput, application, start };
}
`,
  );
  const compiler = join(workspace, "openknot-plugs/rabbitmq/node_modules/typescript/bin/tsc");
  try {
    await exec(process.execPath, [compiler, "-p", join(folder, "tsconfig.json")], { cwd: folder });
    await exec(process.execPath, ["--input-type=module", "-e", 'await import("./out/consumer.js")'], { cwd: folder });
  } catch (error) {
    assert.fail(
      error instanceof Error && "stdout" in error
        ? `${error.message}\n${error.stdout}\n${"stderr" in error ? error.stderr : ""}`
        : String(error),
    );
  }
});
