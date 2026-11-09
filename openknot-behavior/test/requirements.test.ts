import { standalone, InternalBehaviorError, operation, reader, success } from "../src/index.ts";
import { override } from "@openknot-ts/wire";
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
