import { operation, success } from "../src/index.ts";
import { provideBehavior } from "../src/wire.ts";
import { runApplication, composeModule, defineApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("provided behavior modules combine through composeModule and share their lazy load across selections and catalogues", async () => {
  let loads = 0;
  const first = operation({ run: () => success({ output: { changeType: "updated" as const, next: 1 } }) });
  const second = operation({ run: () => success({ output: { changeType: "updated" as const, next: 2 } }) });
  const one = provideBehavior([
    async () => {
      loads++;
      return { first };
    },
  ]);
  const two = provideBehavior([second]);
  const selected = composeModule({ modules: [one.includeOnly([first]), two] }).includeOnly([first, second]);
  assert.equal(one.when(true), one);
  assert.equal(loads, 0);
  const definition = defineApplication({ modules: one.requiredBy(selected) });
  for (let iteration = 0; iteration < 2; iteration++) {
    const app = await runApplication(definition);
    try {
      await app.withScope(async (scope) => {
        assert.deepEqual(
          await scope.resolve(first)(),
          success({ output: { changeType: "updated" as const, next: 1 } }),
        );
        assert.deepEqual(
          await scope.resolve(second)(),
          success({ output: { changeType: "updated" as const, next: 2 } }),
        );
      });
      assert.equal(loads, iteration + 1);
    } finally {
      await app.stop();
    }
  }
  const withoutSecond = selected.exclude([two]);
  const app = await runApplication(defineApplication({ modules: [withoutSecond] }));
  try {
    await app.withScope(async (scope) => {
      assert.deepEqual(await scope.resolve(first)(), success({ output: { changeType: "updated" as const, next: 1 } }));
      assert.throws(() => scope.resolve(second), /excluded|unavailable/);
    });
  } finally {
    await app.stop();
  }
});
