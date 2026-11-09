import { operation, reader, success } from "../src/index.ts";
import { provideBehavior } from "../src/wire.ts";
import type { DeferredModule } from "@openknot-ts/wire";
import {
  hook,
  override,
  runApplication,
  defineApplication,
  composeModule,
  resource,
  unit,
  plug,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const valueOf = (value: number) =>
  operation({
    requirements: {},
    run: () => success({ output: { changeType: "updated" as const, next: value } }),
  });

test("behavior provision accepts native units through every source form without widening operation requirements", async () => {
  const setting = unit({ factory: () => 42 });
  for (const provided of [
    provideBehavior([setting]),
    provideBehavior([{ setting }]),
    provideBehavior([async () => ({ setting })]),
  ]) {
    const app = await runApplication(defineApplication({ modules: [provided.includeOnly([setting])] }), {
      overrides: [override(setting, 7)],
    });
    try {
      assert.equal(app.resolve(setting), 7);
    } finally {
      await app.stop();
    }
  }
  const lifecycle = hook({ run() {} });
  const storage = resource({
    async initialize() {
      return { value: 1, release() {} };
    },
  });
  for (const invalid of [lifecycle, storage]) {
    assert.throws(() => Reflect.apply(provideBehavior, undefined, [[invalid]]), /invalid|does not accept/);
    const imported = Reflect.apply(provideBehavior, undefined, [[async () => ({ invalid })]]) as ReturnType<
      typeof provideBehavior
    >;
    await assert.rejects(runApplication(defineApplication({ modules: [imported] })), /invalid export 'invalid'/);
  }
});

test("provideBehavior discovers private reader/child-operation requirements and wires without manual integrations", async () => {
  const find = reader<(id: string) => string>();
  const child = operation<string>()({
    requirements: { find },
    run: (id, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find(id) } }),
  });
  const parent = operation<string>()({
    requirements: { child },
    run: (id, ctx) => ctx.child(id),
  });
  const sources = [parent];
  const behavior = provideBehavior(sources);
  sources.length = 0;
  const app = await runApplication(
    defineApplication({
      modules: [
        behavior,
        composeModule({
          providers: { binding: plug({ port: find, bind: () => (id) => `role:${id}` }) },
        }),
      ],
    }),
  );
  try {
    assert.throws(() => app.resolve(parent), /withScope/);
    await app.withScope(async (scope) => {
      const result = await scope.resolve(parent)("r1");
      assert.deepEqual(result, success({ output: { changeType: "updated" as const, next: "role:r1" } }));
      assert.equal(scope.resolve(find)("r2"), "role:r2");
    });
  } finally {
    await app.stop();
  }
});

test("native module imports are lazy, preserve reference identities and load once per app across selections", async () => {
  let loads = 0;
  const source = provideBehavior([
    async () => {
      loads += 1;
      return import("./fixtures/operations.ts");
    },
  ]);
  const { readFixture } = await import("./fixtures/operations.ts");
  const { fixtureReader } = await import("./fixtures/contracts.ts");
  const binding = composeModule({
    providers: { fixtureBinding: plug({ port: fixtureReader, bind: () => () => 42 }) },
  });
  const definition = defineApplication({
    modules: source.requiredBy(composeModule({ modules: [source.includeOnly([readFixture]), binding] })),
  });
  assert.equal(loads, 0);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const app = await runApplication(definition);
    try {
      await app.withScope(async (scope) =>
        assert.deepEqual(
          await scope.resolve(readFixture)(),
          success({ output: { changeType: "updated" as const, next: 42 } }),
        ),
      );
    } finally {
      await app.stop();
    }
    assert.equal(loads, iteration + 1);
  }
});

test("composition uses references even when separate namespaces export the same name", async () => {
  const first = valueOf(1);
  const second = valueOf(2);
  const namespace = { run: first };
  const one = provideBehavior([namespace, first]);
  namespace.run = valueOf(99);
  const app = await runApplication(
    defineApplication({ modules: [one, provideBehavior([async () => ({ run: second })])] }),
  );
  try {
    await app.withScope(async (scope) => {
      assert.deepEqual(await scope.resolve(first)(), success({ output: { changeType: "updated" as const, next: 1 } }));
      assert.deepEqual(await scope.resolve(second)(), success({ output: { changeType: "updated" as const, next: 2 } }));
    });
  } finally {
    await app.stop();
  }
});

test("composed module selectors retain hard exclusions and dependency-only activation", async () => {
  const find = reader<() => number>();
  const run = operation({
    requirements: { find },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find() } }),
  });
  const behavior = provideBehavior([run]);
  const bindings = composeModule({
    providers: { binding: plug({ port: find, bind: () => () => 7 }) },
  });
  const app = await runApplication(
    defineApplication({
      modules: bindings.requiredBy(behavior.includeOnly([run])),
    }),
  );
  try {
    await app.withScope(async (scope) =>
      assert.deepEqual(await scope.resolve(run)(), success({ output: { changeType: "updated" as const, next: 7 } })),
    );
  } finally {
    await app.stop();
  }
  for (const view of [
    behavior.exclude([run]),
    behavior.when(false),
    composeModule({ modules: [behavior] }).exclude([behavior]),
  ]) {
    const excluded = await runApplication(defineApplication({ modules: behavior.requiredBy(view, bindings) }));
    try {
      await assert.rejects(
        excluded.withScope((scope) => scope.resolve(run)),
        /excluded|unavailable/,
      );
    } finally {
      await excluded.stop();
    }
  }
  await assert.rejects(
    runApplication(defineApplication({ modules: [behavior.exclude([find]), bindings] })),
    /reader 'find' is unavailable or excluded \(operation → find\)/,
  );
  await assert.rejects(runApplication(defineApplication({ modules: [behavior.includeOnly([valueOf(2)])] })), /outside/);
});

test("invalid direct or imported behavior exports fail before resources initialize", async () => {
  for (const source of ["./operations", { href: "file:///operations/" }, valueOf(1), null, 42]) {
    assert.throws(() => Reflect.apply(provideBehavior, undefined, [source]), /expects an array/);
  }
  const contract = reader<() => number>();
  for (const source of [[contract], [{ invalid: contract }], [[valueOf(1)]], [null]]) {
    assert.throws(() => Reflect.apply(provideBehavior, undefined, [source]), /invalid|does not accept a reader/);
  }
  let acquired = 0;
  const database = resource({
    initialize: () => {
      acquired += 1;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  const invalid = Reflect.apply(provideBehavior, undefined, [[async () => ({ invalid: contract })]]) as DeferredModule;
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [invalid, composeModule({ providers: { database } })],
      }),
    ),
    /invalid export 'invalid'/,
  );
  assert.equal(acquired, 0);
  const cause = new Error("import failed");
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [provideBehavior([() => Promise.reject(cause)])],
      }),
    ),
    (error) => error === cause,
  );
});

test("operations are execution-scoped", async () => {
  const operation = valueOf(1);
  const app = await runApplication(
    defineApplication({ modules: [provideBehavior([operation]).includeOnly([operation])] }),
  );
  try {
    assert.throws(() => app.resolve(operation), /withScope/);
    await app.withScope(async (scope) => {
      assert.deepEqual(
        await scope.resolve(operation)(),
        success({ output: { changeType: "updated" as const, next: 1 } }),
      );
    });
  } finally {
    await app.stop();
  }
});
