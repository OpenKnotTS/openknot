import type {} from "../src/wire.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("subscription and publisher declarations, native bindings and root imports work in an isolated consumer", () => {
  const project = mkdtempSync(join(tmpdir(), "openknot-subscriptions-consumer-"));
  try {
    for (const [name, folder] of [
      ["flow", "openknot-flow"],
      ["behavior", "openknot-behavior"],
      ["wire", "openknot-wire"],
      ["tracing", "openknot-capabilities/tracing"],
      ["logging", "openknot-capabilities/logging"],
      ["versioning", "openknot-capabilities/versioning"],
    ] as const) {
      const destination = join(project, "node_modules", "@openknot-ts", name);
      mkdirSync(destination, { recursive: true });
      const source = new URL(`../../${folder}/`, import.meta.url);
      cpSync(new URL("dist/", source), join(destination, "dist"), { recursive: true });
      cpSync(new URL("package.json", source), join(destination, "package.json"));
    }
    const standard = join(project, "node_modules", "@standard-schema", "spec");
    mkdirSync(join(standard, ".."), { recursive: true });
    cpSync(new URL("../../openknot-behavior/node_modules/@standard-schema/spec/", import.meta.url), standard, {
      recursive: true,
    });
    writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2024", "DOM"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["consumer.ts"],
      }),
    );
    writeFileSync(
      join(project, "consumer.ts"),
      `
import type { ResolvedRequirement, Upserted, Deleted } from "@openknot-ts/flow";
import { broadcast, topic, guard, publisher, command, unitOfWork, hook, upserted, writer } from "@openknot-ts/flow";
import { deleted, success } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/flow/wire";
import { plug } from "@openknot-ts/wire";
const save = writer<(id: string) => Promise<Upserted<{ id: string }>>>();
const remove = writer<(id: string) => Promise<Deleted<{ id: string }>>>();
const removeId = writer<(id: string) => Promise<Deleted<string>>>();
plug({ port: save, bind: () => async id => upserted({ id }) });
plug({ port: remove, bind: () => async id => deleted({ id }) });
plug({ port: removeId, bind: () => async id => deleted(id) });
// @ts-expect-error The declared deletion payload is preserved without Wire.
plug({ port: removeId, bind: () => async id => deleted({ id }) });
// @ts-expect-error Native persistence results preserve their discriminant without Wire.
plug({ port: save, bind: () => async id => deleted({ id }) });
const access = guard<string>()({ run: (_token) => success() });
const recipients = topic<{ readonly userId: string; readonly scope: "read" }, number>()({ guards: { access } });
plug({ port: recipients, bind: () => ({ publish(key) { const scope: "read" = key.scope; void scope; }, subscribe: async function* () { yield 1; } }) });
declare const targeted: ResolvedRequirement<typeof recipients>;
void targeted.subscribe({ input: { userId: "alice", scope: "read" }, access: "token" });
// @ts-expect-error Structured key inference does not need Wire.
targeted.publish("alice", 1);

const roles = topic<"roles", string>()({ guards: { access } });
const logs = broadcast<{ readonly text: string }>()({ guards: { access } });
const bindings = [
  plug({ port: roles, bind: () => ({ publish() {}, subscribe: async function* () { yield "changed"; } }) }),
  plug({ port: logs, bind: () => ({ publish() {}, subscribe: async function* () { yield { text: "created" }; } }) }),
];
void bindings;
declare const changes: ResolvedRequirement<typeof roles>;
declare const notifications: ResolvedRequirement<typeof logs>;
void changes.publish("roles", "changed");
void notifications.publish({ text: "created" });
const stream: Promise<AsyncIterable<string>> = changes.subscribe({ input: "roles", access: "token" }); void stream;
// @ts-expect-error Required named guard inputs are retained without Wire.
notifications.subscribe({ input: undefined });
// @ts-expect-error Payload inference is retained without Wire.
notifications.publish({ text: 42 });
// @ts-expect-error Topic key inference is retained without Wire.
changes.publish("other", "changed");
const completion = hook<{ readonly status: "committed" }>()({ run: (_event) => success() });
const transaction = unitOfWork({ hooks: { afterCommit: [completion] } });
const transactional = command({ unitOfWork: transaction, requirements: { logs },
  run: async (_input, ctx) => { await ctx.logs.publish({ text: "created" }); return success(ctx.actor); },
});
void transactional;
const events = publisher<number>();
declare const outgoing: ResolvedRequirement<typeof events>;
void outgoing.publish(1);
`,
    );
    const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    const checked = spawnSync(process.execPath, [compiler, "-p", project], { cwd: project, encoding: "utf8" });
    assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
    const runtime = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import * as api from "@openknot-ts/flow";
const state = { id: "native" };
const written = api.upserted(state);
if (written.changeType !== "upserted" || written.next !== state || !Object.isFrozen(written) || Object.isFrozen(state)) {
  throw new Error("Invalid persistence result ownership");
}
const logs = api.broadcast()({});
if (!api.isBroadcast(logs) || "hub" in api || "channel" in api || "plug" in api) { throw new Error("Invalid standalone contract API"); }
`,
      ],
      { cwd: project, encoding: "utf8" },
    );
    assert.equal(runtime.status, 0, `${runtime.stdout}${runtime.stderr}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
