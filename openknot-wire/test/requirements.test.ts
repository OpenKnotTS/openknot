import { runApplication, hook, composeModule, defineApplication, resource, unit } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("every lifecycle factory receives the same immutable resolved requirement snapshot", async () => {
  const original = unit({ factory: () => 42 });
  const changed = unit({
    factory: () => {
      throw new Error("A requirement getter was read twice");
    },
  });
  const reads: number[] = [];
  function requirements() {
    const index = reads.push(0) - 1;
    return {
      get value() {
        reads[index] = reads[index]! + 1;
        return reads[index] === 1 ? original : changed;
      },
    };
  }
  const observed: number[] = [];
  const selected = unit({
    requirements: requirements(),
    factory: (ctx) => {
      assert.ok(Object.isFrozen(ctx));
      return ctx.value;
    },
  });
  const database = resource({
    requirements: requirements(),
    async initialize(ctx) {
      assert.ok(Object.isFrozen(ctx));
      observed.push(ctx.value);
      return { value: ctx.value, release() {} };
    },
  });
  const task = hook({
    requirements: requirements(),
    run(ctx) {
      assert.ok(Object.isFrozen(ctx));
      observed.push(ctx.value);
    },
  });
  const source = hook({
    requirements: requirements(),
    run(ctx) {
      assert.ok(Object.isFrozen(ctx));
      observed.push(ctx.value);
    },
  });
  const module = composeModule({ providers: { selected, database, task, source } });
  const app = await runApplication(defineApplication({ modules: [module], startupTasks: [task, source] }));
  try {
    assert.equal(app.resolve(selected), 42);
    assert.equal(app.resolve(database), 42);
    assert.deepEqual(observed, [42, 42, 42]);
    assert.deepEqual(reads, [1, 1, 1, 1]);
    assert.ok([selected, database, task, source].every((definition) => Object.isFrozen(definition.requirements)));
  } finally {
    await app.stop();
  }
});

test("provider declarations validate requirement maps and lifecycle contracts", () => {
  for (const [declare, action] of [
    [unit, "factory"],
    [resource, "initialize"],
    [hook, "run"],
  ] as const) {
    const create = (options: unknown) => Reflect.apply(declare, undefined, [options]);
    const declaration = { [action]: () => ({}) };
    for (const requirements of [null, [], 42, "dependency", () => 1]) {
      assert.throws(() => create({ requirements, ...declaration }), /Requirements/);
    }
    assert.throws(() => create({ requirements: { dependency: 42 }, ...declaration }), /reference/);
    assert.throws(() => create(() => 1), new RegExp(action));
    const empty = create(declaration);
    assert.deepEqual(empty.requirements, {});
    assert.ok(Object.isFrozen(empty.requirements));
  }
  assert.throws(() => Reflect.apply(hook, undefined, [{ run: () => {}, lifetime: "scoped" }]), /singleton/);
});
