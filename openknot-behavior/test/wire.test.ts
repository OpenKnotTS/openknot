import type { Outcome } from "../src/index.ts";
import { error, InternalBehaviorError, standalone, failure, model, operation, reader, success } from "../src/index.ts";
import { behaviorAdapter } from "../src/internal/wire/adapter.ts";
import type { DefinitionAdapter } from "@openknot-ts/wire";
import {
  DefinitionIntegrationMarker,
  runApplication,
  defineApplication,
  composeModule,
  override,
  resource,
  unit,
  plug,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("raw operations and reader bindings compose by reference and capture resolved dependencies", async () => {
  const find = reader<(id: string) => Promise<string>>();
  const child = operation<string>()({
    requirements: { readName: find },
    run: async (id, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.readName(id) } }),
  });
  const parent = operation<string>()({
    requirements: { nested: child },
    run: async (id, ctx) => {
      const result = await ctx.nested(id);
      return result.isError
        ? result
        : success({ output: { changeType: "updated" as const, next: result.value.output.next.toUpperCase() } });
    },
  });
  const bindings = composeModule({
    providers: { storageBinding: plug({ port: find, bind: () => (id) => Promise.resolve(`role:${id}`) }) },
  });
  const behavior = composeModule({
    providers: { find, parent, ignored: model<unknown>()({ name: "ignored", mutations: {} }) },
  });
  const app = await runApplication(defineApplication({ modules: bindings.requiredBy(behavior) }));
  try {
    assert.throws(() => app.resolve(parent), /withScope/);
    await app.withScope(async (scope) => {
      const run = scope.resolve(parent);
      assert.equal(run, scope.resolve(parent));
      await Promise.resolve();
      const result = await run("r1");
      assert.deepEqual(result, success({ output: { changeType: "updated" as const, next: "ROLE:R1" } }));
      assert.equal(scope.resolve(find), scope.resolve(find));
    });
  } finally {
    await app.stop();
  }
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: bindings.requiredBy(behavior.exclude([child]).includeOnly([parent])),
      }),
    ),
    /excluded/,
  );
});

test("standalone and wired execution share expected errors, defects and event semantics", async () => {
  const Rejected = error("Rejected");
  type Rejected = ReturnType<typeof Rejected>;
  const original = new Error("read failed");
  const find = reader<() => Promise<number>>();
  const broken = operation({
    tag: "broken-read",
    requirements: { find },
    run: async (_input, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.find() } }),
  });
  const expected = Rejected("business rule");
  const rejected = operation({ requirements: {}, run: () => failure(expected) });
  const events = [{ type: "Changed" }];
  const eventful = operation<void, number, (typeof events)[number]>()({
    requirements: {},
    run: () => success({ output: { changeType: "updated" as const, next: 1 }, events }),
  });
  const binding = plug({ port: find, bind: () => () => Promise.reject(original) });
  const definitions = composeModule({ providers: { find, binding, broken, rejected, eventful } });
  const app = await runApplication(defineApplication({ modules: [definitions] }));
  try {
    await app.withScope(async (scope) => {
      const wired = await scope
        .resolve(broken)()
        .catch((error: unknown) => error);
      const alone = await standalone(broken, [override(find, () => Promise.reject(original))])().catch(
        (error: unknown) => error,
      );
      assert.ok(InternalBehaviorError.is(wired) && InternalBehaviorError.is(alone));
      assert.equal(wired.cause, original);
      assert.equal(wired.boundary, alone.boundary);
      const rejection = await scope.resolve(rejected)();
      assert.equal(rejection.isError, true);
      if (rejection.isError) {
        assert.equal(rejection.error, expected);
      }
      const emitted = await scope.resolve(eventful)();
      assert.equal(emitted.isError, false);
      if (!emitted.isError) {
        assert.notEqual(emitted.value.events, events);
        assert.ok(Object.isFrozen(emitted.value.events));
        assert.deepEqual(emitted.value.events, events);
      }
    });
  } finally {
    await app.stop();
  }
});

test("includeOnly and requiredBy activate only selected raw operations", async () => {
  let reads = 0;
  const read = reader<() => number>();
  const selected = operation({
    requirements: { read },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.read() } }),
  });
  const missing = reader<() => number>();
  const dormant = operation({
    requirements: { missing },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.missing() } }),
  });
  const behavior = composeModule({ providers: { read, selected, dormant } });
  const implementations = composeModule({
    providers: { readImplementation: plug({ port: read, bind: () => () => ++reads }) },
  });
  const app = await runApplication(
    defineApplication({
      modules: implementations.requiredBy(behavior.includeOnly([selected])),
    }),
  );
  try {
    assert.equal(reads, 0);
    await app.withScope(async (scope) => {
      assert.deepEqual(
        await scope.resolve(selected)(),
        success({ output: { changeType: "updated" as const, next: 1 } }),
      );
      assert.throws(() => scope.resolve(dormant), /The reader has no implementation/);
    });
  } finally {
    await app.stop();
  }
});

test("reader and binding exclusions cannot be reversed by another module or registry", async () => {
  const find = reader<() => number>();
  const binding = plug({ port: find, bind: () => () => 1 });
  const run = operation({
    requirements: { find },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find() } }),
  });
  const contracts = composeModule({ providers: { find, run } });
  const implementations = composeModule({ providers: { binding } });
  const all = composeModule({ modules: [contracts, implementations] });
  for (const view of [
    all.exclude([find]),
    all.exclude([binding]),
    all.exclude([implementations]),
    implementations.when(false),
  ]) {
    await assert.rejects(
      runApplication(
        defineApplication({
          modules: all.requiredBy(view.includeOnly([]), contracts.includeOnly([run])),
        }),
      ),
      /excluded|no implementation/,
    );
  }
});

test("duplicate implementations fail before resources are acquired while aliases preserve identity", async () => {
  let initialized = 0;
  const db = resource({
    initialize: () => {
      initialized += 1;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  const find = reader<() => number>();
  const first = plug({ port: find, bind: () => () => 1 });
  const second = plug({ port: find, bind: () => () => 2 });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { find, first, second, db } })],
      }),
    ),
    /implementations/,
  );
  assert.equal(initialized, 0);
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { find, alias: find, first, db } })],
    }),
  );
  try {
    await app.withScope((scope) => {
      assert.equal(scope.resolve(find)(), 1);
    });
    assert.equal(initialized, 1);
  } finally {
    await app.stop();
  }
});

test("missing implementations fail at startup, never as behavior business errors", async () => {
  const find = reader<() => number>();
  const run = operation({
    requirements: { find },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find() } }),
  });
  for (const definition of [
    defineApplication({ modules: [composeModule({ providers: { find, run } })] }),
    defineApplication({ modules: [composeModule({ providers: { run } }).includeOnly([run])] }),
  ]) {
    // @ts-expect-error The compiler reports the unbound reader too; this checks the startup backstop.
    await assert.rejects(runApplication(definition), /reader 'find' has no implementation \(operation 'run' → find\)/);
  }
});

test("raw overrides preserve canonical reader and operation identities", async () => {
  const find = reader<() => number>();
  const run = operation({
    requirements: { find },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find() } }),
  });
  const module = composeModule({ providers: { find, run } });
  const definition = defineApplication({ modules: [module] });
  const app = await runApplication(definition, { overrides: [override(find, () => 42)] });
  // Overriding run makes its reader unnecessary, at compile time as at startup.
  const other = await runApplication(definition, {
    overrides: [
      override(run, () => Promise.resolve(success({ output: { changeType: "updated" as const, next: 99 } }))),
    ],
  });
  try {
    await app.withScope(async (scope) =>
      assert.deepEqual(await scope.resolve(run)(), success({ output: { changeType: "updated" as const, next: 42 } })),
    );
    await other.withScope(async (scope) =>
      assert.deepEqual(await scope.resolve(run)(), success({ output: { changeType: "updated" as const, next: 99 } })),
    );
  } finally {
    await Promise.all([app.stop(), other.stop()]);
  }
});

test("scoped resources and reference-based readers retain lifetime and cleanup rules", async () => {
  let sequence = 0;
  const released: number[] = [];
  const db = resource({
    initialize: () => {
      const id = ++sequence;
      return Promise.resolve({
        value: { id },
        release() {
          released.push(id);
        },
      });
    },
    lifetime: "scoped",
  });
  const read = reader<() => number>();
  const run = operation({
    requirements: { read },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.read() } }),
  });
  const implementation = unit({
    provides: read,
    requirements: { db },
    factory:
      ({ db }: { db: { readonly id: number } }) =>
      () =>
        db.id,
    lifetime: "scoped",
  });
  const module = composeModule({ providers: { db, read, run, implementation } });
  const app = await runApplication(
    defineApplication({
      modules: [module],
    }),
  );
  try {
    const outputs: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      await app.withScope(async (scope) => {
        const result = await scope.resolve(run)();
        assert.equal(result.isError, false);
        if (!result.isError) {
          outputs.push(result.value.output.next);
        }
      });
    }
    assert.deepEqual(outputs, [1, 2]);
    assert.deepEqual(released, [1, 2]);
  } finally {
    await app.stop();
  }
  const singleton = unit({
    requirements: { run },
    factory: ({ run }: { run: () => Promise<Outcome<{ output: { changeType: "updated"; next: number } }, Error>> }) =>
      run,
  });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ modules: [module], providers: { singleton } }).includeOnly([singleton])],
      }),
    ),
    /shorter lifetime/,
  );
});

test("two integrations that recognize one definition fail at startup", async () => {
  const read = reader<() => number>();
  const binding = plug({ port: read, bind: () => () => 1 });
  const duplicate: DefinitionAdapter = { name: "duplicate", adapt: (value) => behaviorAdapter().adapt(value) };
  const other = { [DefinitionIntegrationMarker]: { name: "duplicate", references: [], load: async () => duplicate } };
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { binding, other } })] })),
    /Multiple adapters/,
  );
});
