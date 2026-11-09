import { standalone, operation, success } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("operations may omit requirements and keep their normalized output and event contract", async () => {
  const read = operation<number>()({
    run: (input, ctx) => {
      assert.deepEqual(Object.keys(ctx), []);
      assert.ok(Object.isFrozen(ctx));
      return success({ output: { changeType: "updated" as const, next: input * 2 } });
    },
  });
  assert.deepEqual(read.requirements, {});
  assert.ok(Object.isFrozen(read.requirements));
  assert.deepEqual(await standalone(read)(21), success({ output: { changeType: "updated" as const, next: 42 } }));
  for (const requirements of [null, [], 42]) {
    assert.throws(
      () =>
        Reflect.apply(operation(), undefined, [
          { requirements, run: () => success({ output: { changeType: "updated" as const, next: 1 } }) },
        ]),
      /Requirements/,
    );
  }
});
