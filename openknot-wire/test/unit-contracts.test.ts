import {
  composeModule,
  defineApplication,
  describeApplication,
  optional,
  override,
  resource,
  runApplication,
  unit,
} from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("native unit contracts fail validation before resources and report their requirement path", async () => {
  const handler = unit.contract<() => string>();
  const server = unit({ requirements: { handler }, factory: ({ handler }) => handler });
  let opened = false;
  const connection = resource({
    initialize: async () => {
      opened = true;
      return { value: {}, release() {} };
    },
  });
  const definition = defineApplication({
    modules: [composeModule({ providers: { server, connection } })],
  });
  assert.ok((await describeApplication(definition)).problems.some((problem) => problem.includes("handler")));
  // @ts-expect-error A reachable native contract needs an implementation.
  await assert.rejects(runApplication(definition), /handler.*has no implementation/);
  assert.equal(opened, false);
});

test("a reference's own declaration is its default and one provides binding replaces it", async () => {
  const handler = unit({ factory: () => (): string => "default" });
  const implementation = unit({ provides: handler, factory: () => () => "explicit" });
  const server = unit({ requirements: { handler }, factory: ({ handler }) => handler() });
  for (const explicit of [false, true]) {
    const module = composeModule({ providers: { server, ...(explicit ? { implementation } : {}) } });
    const app = await runApplication(defineApplication({ modules: [module] }));
    try {
      assert.equal(app.resolve(server), explicit ? "explicit" : "default");
    } finally {
      await app.stop();
    }
  }
});

test("unbound native contracts count as absent for optional consumers", async () => {
  const handler = unit.contract<() => string>();
  const consume = unit({ requirements: { handler: optional(handler) }, factory: ({ handler }) => handler });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { handler, consume } })] }),
  );
  try {
    assert.equal(app.resolve(consume), undefined);
  } finally {
    await app.stop();
  }
});

test("an application's override or binding binds a contract that is only consumed optionally", async () => {
  const handler = unit.contract<() => string>();
  const consume = unit({ requirements: { handler: optional(handler) }, factory: ({ handler }) => handler?.() });
  const definition = defineApplication({ modules: [composeModule({ providers: { consume } })] });
  const absent = await runApplication(definition);
  const overridden = await runApplication(definition, { overrides: [override(handler, () => "override")] });
  const binding = unit({ provides: handler, factory: () => () => "binding" });
  const bound = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { consume, binding } })] }),
  );
  try {
    assert.equal(absent.resolve(consume), undefined);
    assert.equal(overridden.resolve(consume), "override");
    assert.equal(bound.resolve(consume), "binding");
  } finally {
    await Promise.all([absent.stop(), overridden.stop(), bound.stop()]);
  }
});

test("a bound optional dependency is validated and acquired like a required one", async () => {
  let acquired = 0;
  const database = resource({
    async initialize() {
      acquired++;
      return { value: 42, release() {} };
    },
  });
  const reader = unit({ requirements: { database: optional(database) }, factory: ({ database }) => database });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { reader, database } }).includeOnly([reader])] }),
  );
  try {
    assert.equal(app.resolve(reader), 42);
    assert.equal(acquired, 1);
  } finally {
    await app.stop();
  }
  // Its own requirements are checked before any resource starts.
  const missing = unit.contract<string>();
  const broken = unit({ requirements: { missing }, factory: ({ missing }) => missing });
  const consumer = unit({ requirements: { broken: optional(broken) }, factory: ({ broken }) => broken });
  let opened = 0;
  const unrelated = resource({
    async initialize() {
      opened++;
      return { value: 0, release() {} };
    },
  });
  const definition = defineApplication({
    modules: [composeModule({ providers: { consumer, broken, unrelated } }).includeOnly([consumer, unrelated])],
  });
  assert.deepEqual((await describeApplication(definition)).problems, [
    "- unit 'missing' has no implementation (unit 'consumer' → broken → missing)",
  ]);
  await assert.rejects(runApplication(definition), /unit 'missing' has no implementation/);
  assert.equal(opened, 0);
});

test("native contracts accept bindings and final overrides", async () => {
  const handler = unit.contract<() => string>();
  const server = unit({ requirements: { handler }, factory: ({ handler }) => handler() });
  const implementation = unit({ provides: handler, factory: () => () => "bound" });
  const definition = defineApplication({
    modules: [composeModule({ providers: { server, implementation } })],
  });
  const app = await runApplication(definition, { overrides: [override(handler, () => "overridden")] });
  try {
    assert.equal(app.resolve(server), "overridden");
  } finally {
    await app.stop();
  }
});
