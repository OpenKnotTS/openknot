import { standalone, InternalBehaviorError, operation, reader, success } from "../src/index.ts";
import type { LogRecord } from "@openknot-ts/logging";
import { createLogger } from "@openknot-ts/logging";
import { logger, logging } from "@openknot-ts/logging/wire";
import { composeModule, defineApplication, override, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("operation construction captures the validated run function once and retains its diagnostic tag", async () => {
  let reads = 0;
  const cause = new Error("operation defect");
  const definition = operation<boolean>()({
    requirements: {},
    tag: "role.rename",
    get run() {
      reads++;
      if (reads > 1) {
        throw new Error("run was read again");
      }
      return (crash: boolean) => {
        if (crash) {
          throw cause;
        }
        return success({ output: { changeType: "updated" as const, next: "renamed" } });
      };
    },
  });
  assert.equal(reads, 1);
  assert.ok(Object.isFrozen(definition));
  const run = standalone(definition);
  assert.deepEqual(await run(false), success({ output: { changeType: "updated" as const, next: "renamed" } }));
  await assert.rejects(
    run(true),
    (error) => InternalBehaviorError.is(error) && error.cause === cause && error.boundary === "role.rename",
  );
  assert.equal(reads, 1);
});

test("operations log through the logger requirement, resolved by Wire or supplied to standalone", async (t) => {
  const records: LogRecord[] = [];
  const sink = { write: (record: LogRecord) => void records.push(record) };
  const rename = operation<string>()({
    requirements: { logger },
    run: (name, { logger }) => {
      logger.info("renaming", { name });
      return success({ output: { changeType: "updated" as const, next: name } });
    },
  });
  const provided = unit({ provides: logging, factory: () => sink });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { rename, provided } })] }),
    { env: {} },
  );
  try {
    await app.withScope((scope) => scope.resolve(rename)("wired"), { root: rename });
  } finally {
    await app.stop();
  }
  await standalone(rename, [override(logger, createLogger(sink))])("standalone");
  const info = t.mock.method(console, "info", () => {});
  await standalone(rename)("console");
  assert.deepEqual(
    records.map(({ attributes }) => attributes),
    [{ name: "wired" }, { name: "standalone" }],
  );
  assert.equal(info.mock.callCount(), 1);
  assert.throws(
    () =>
      operation({ requirements: { other: unit({ factory: () => 1 }) } as never, run: () => success({ output: [] }) }),
    /Invalid operation requirement: other/,
  );
});

test("operation requirements are snapshotted once and preserve the narrow read/operation graph", async () => {
  const original = reader<() => string>();
  const changed = reader<() => string>();
  let reads = 0;
  const requirements = {
    get lookup() {
      reads++;
      return reads === 1 ? original : changed;
    },
  };
  const child = operation({
    requirements,
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.lookup() } }),
  });
  const parent = operation({ requirements: { child }, run: (_input, ctx) => ctx.child() });
  assert.equal(reads, 1);
  assert.equal(child.requirements.lookup, original);
  assert.ok(Object.isFrozen(child.requirements));
  assert.deepEqual(
    await standalone(parent, [override(original, () => "original")])(),
    success({ output: { changeType: "updated" as const, next: "original" } }),
  );
  assert.equal(reads, 1);
});
