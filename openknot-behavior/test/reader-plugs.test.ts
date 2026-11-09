import { reader, operation, success } from "../src/index.ts";
import { provideBehavior } from "../src/wire.ts";
import { decorate, plug, providePlugs, defineApplication, override, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("Behavior reader plugs discover their integration and build bindings over application-wide values once", async () => {
  const setting = unit({ factory: () => 1 });
  const first = reader<() => number>();
  const second = reader<(value: number) => number>();
  let constructions = 0;
  const readers = reader.compose({ first, second });
  const binding = plug({
    port: readers,
    requirements: { setting },
    bind: (ctx) => {
      assert.ok(Object.isFrozen(ctx));
      constructions++;
      return {
        first: () => ctx.setting,
        second: (value) => ctx.setting + value,
      };
    },
  });
  const calculate = operation({
    requirements: { first, second },
    run: (_input, ctx) => success({ output: { changeType: "created", next: ctx.first() + ctx.second(1) } }),
  });
  const app = await runApplication(
    defineApplication({ modules: [provideBehavior([calculate]), providePlugs([binding])] }),
    {
      overrides: [override(setting, 20)],
    },
  );
  try {
    assert.equal(constructions, 0);
    for (let count = 1; count <= 2; count++) {
      await app.withScope(async (scope) => {
        assert.deepEqual(await scope.resolve(calculate)(), success({ output: { changeType: "created", next: 41 } }));
        assert.equal(scope.resolve(first)(), 20);
      });
      assert.equal(constructions, 1);
    }
  } finally {
    await app.stop();
  }
});

test("a reader binding over a scoped value is built in every scope that needs it", async () => {
  let requests = 0;
  const request = unit({ lifetime: "scoped", factory: () => ++requests });
  const current = reader<() => number>();
  let constructions = 0;
  const binding = plug({
    port: current,
    requirements: { request },
    bind: ({ request }) => {
      constructions++;
      return () => request;
    },
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([binding])] }));
  try {
    for (let count = 1; count <= 2; count++) {
      assert.equal(await app.withScope((scope) => scope.resolve(current)()), count);
      assert.equal(constructions, count);
    }
  } finally {
    await app.stop();
  }
});

test("a decoration over a scoped value keeps the binding it wraps per scope", async () => {
  let requests = 0;
  const request = unit({ lifetime: "scoped", factory: () => ++requests });
  const current = reader<() => number>();
  const binding = plug({ port: current, bind: () => () => 0 });
  const tagged = decorate(current, {
    requirements: { request },
    wrap:
      (read, { request }) =>
      () =>
        read() + request,
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([binding, tagged])] }));
  try {
    assert.equal(await app.withScope((scope) => scope.resolve(current)()), 1);
    assert.equal(await app.withScope((scope) => scope.resolve(current)()), 2);
  } finally {
    await app.stop();
  }
});
