import { isOperationComposition, model, operation, reader, success } from "../src/index.ts";
import { provideBehavior } from "../src/wire.ts";
import { runApplication, defineApplication, composeModule, override, plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("operation compositions snapshot independent definitions and reject invalid members", () => {
  const first = operation<number>()({
    requirements: {},
    run: (value) => success({ output: { changeType: "updated" as const, next: value } }),
  });
  const second = operation<string>()({
    requirements: {},
    run: (value) => success({ output: { changeType: "updated" as const, next: value } }),
  });
  const members = { first, second };
  const group = operation.compose(members);
  Object.assign(members, { first: second });
  assert.ok(isOperationComposition(group));
  assert.ok(!isOperationComposition(first));
  assert.deepEqual(group.members, { first, second });
  assert.equal(group.members.first, first);
  assert.ok(Object.isFrozen(group) && Object.isFrozen(group.members));
  assert.throws(() => operation.compose({}), /non-empty/);
  assert.throws(() => operation.compose({ first, duplicate1: first }), /Duplicate/);
  for (const value of [
    [reader<() => number>()],
    [group],
    [model<unknown>()({ name: "model", mutations: {} })],
    [null],
    {},
  ]) {
    assert.throws(() => Reflect.apply(operation.compose, undefined, [value]), /named object of operations/);
  }
});

test("grouped operations retain independent DI references, inferred dependencies, overrides and exclusions", async () => {
  const read = reader<(id: string) => string>();
  const first = operation<string>()({
    requirements: { read },
    run: (id, ctx) => success({ output: { changeType: "updated" as const, next: ctx.read(id) } }),
  });
  const second = operation<number>()({
    requirements: {},
    run: (value) => success({ output: { changeType: "updated" as const, next: value * 2 } }),
  });
  const group = operation.compose({ first, second });
  const behavior = provideBehavior([group, { roleOperations: group }, first]);
  const data = composeModule({ providers: { binding: plug({ port: read, bind: () => (id) => `role:${id}` }) } });
  const app = await runApplication(defineApplication({ modules: data.requiredBy(behavior.includeOnly([first])) }), {
    overrides: [
      override(second, (value) =>
        Promise.resolve(success({ output: { changeType: "updated" as const, next: value * 3 } })),
      ),
    ],
  });
  try {
    await app.withScope(async (scope) => {
      assert.equal(scope.resolve(first), scope.resolve(group.members.first));
      assert.deepEqual(
        await scope.resolve(first)("r1"),
        success({ output: { changeType: "updated" as const, next: "role:r1" } }),
      );
      assert.deepEqual(
        await scope.resolve(second)(2),
        success({ output: { changeType: "updated" as const, next: 6 } }),
      );
      assert.equal(scope.resolve(read)("r2"), "role:r2");
      assert.throws(() => Reflect.apply(scope.resolve, scope, [group]), /excluded|unavailable/);
    });
  } finally {
    await app.stop();
  }
  const excluded = await runApplication(
    defineApplication({ modules: behavior.requiredBy(behavior.exclude([second]), data) }),
  );
  try {
    await excluded.withScope(async (scope) => {
      assert.throws(() => scope.resolve(second), /excluded|unavailable/);
      assert.deepEqual(
        await scope.resolve(first)("r1"),
        success({ output: { changeType: "updated" as const, next: "role:r1" } }),
      );
    });
  } finally {
    await excluded.stop();
  }
});

test("native namespaces can export operation compositions without loading or registering another wrapper", async () => {
  let loads = 0;
  const behavior = provideBehavior([
    async () => {
      loads++;
      return import("./fixtures/operation-compositions.ts");
    },
  ]);
  assert.equal(loads, 0);
  const { fixtureReader } = await import("./fixtures/contracts.ts");
  const data = composeModule({ providers: { binding: plug({ port: fixtureReader, bind: () => () => 42 }) } });
  const app = await runApplication(defineApplication({ modules: [behavior, data] }));
  try {
    const { fixtureOperations } = await import("./fixtures/operation-compositions.ts");
    await app.withScope(async (scope) => {
      assert.deepEqual(
        await scope.resolve(fixtureOperations.members.readFixture)(),
        success({ output: { changeType: "updated" as const, next: 42 } }),
      );
      assert.deepEqual(
        await scope.resolve(fixtureOperations.members.echo)("echo"),
        success({ output: { changeType: "updated" as const, next: "echo" } }),
      );
    });
    assert.equal(loads, 1);
  } finally {
    await app.stop();
  }
});
