import { command, expose, listener, publisher, writer } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { operation, reader, success } from "@openknot-ts/behavior";
import type { Definition } from "@openknot-ts/wire";
import type { PlugDefinition } from "@openknot-ts/wire";
import {
  plug,
  runApplication,
  defineApplication,
  composeModule,
  override,
  unit,
  resource,
  decorate,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("single reader adapters provide typed .run without a group or exported declaration", async () => {
  const findRole = reader<(id: string) => Promise<string>>();
  const database = unit({ factory: () => ({ find: (id: string) => Promise.resolve(`role:${id}`) }) });
  const binding = plug({
    port: findRole,
    requirements: { database },
    bind:
      ({ database }) =>
      (id) =>
        database.find(id),
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] }));
  assert.throws(() => app.resolve(findRole), /withScope/);
  await app.withScope(async (scope) => {
    assert.equal(await scope.resolve(findRole)("r1"), "role:r1");
    assert.equal(scope.resolve(findRole), scope.resolve(findRole));
  });
  await app.stop();
});

test("single writer adapters and direct writer.using bindings keep their references", async () => {
  const saved: number[] = [];
  const save = writer<(id: number) => Promise<void>>();
  const binding = plug({
    port: save,
    requirements: {},
    bind: () => (id) => {
      saved.push(id);
      return Promise.resolve();
    },
  });
  const direct = writer<() => string>();
  const implementation = plug({ port: direct, bind: () => () => "direct" });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { binding, direct, implementation } })] }),
  );
  await app.withScope(async (scope) => {
    await scope.resolve(save)(42);
    assert.equal(scope.resolve(direct)(), "direct");
  });
  assert.deepEqual(saved, [42]);
  await app.stop();
});

test("named compositions bind once per scope and independent plugs share the scoped resource", async () => {
  const read = reader<() => number>();
  const exists = reader<(id: number) => boolean>();
  const write = writer<(value: number) => number>();
  const remove = writer<() => number>();
  let nextSession = 0;
  let binds = 0;
  const closed: number[] = [];
  const database = resource({
    async initialize() {
      const id = ++nextSession;
      return {
        value: { id },
        release() {
          closed.push(id);
        },
      };
    },
    lifetime: "scoped",
  });
  const readBinding = plug({
    port: reader.compose({ read, exists }),
    requirements: { database },
    bind: ({ database }) => {
      binds++;
      return { read: () => database.id, exists: (id) => id === database.id };
    },
  });
  const writeBinding = plug({
    port: writer.compose({ write, remove }),
    requirements: { database },
    bind: ({ database }) => {
      binds++;
      return { write: (value) => database.id + value, remove: () => database.id };
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { readBinding, writeBinding } })],
    }),
  );
  assert.equal(binds, 0);
  try {
    for (const id of [1, 2]) {
      await app.withScope((scope) => {
        assert.equal(scope.resolve(read)(), id);
        assert.equal(scope.resolve(exists)(id), true);
        assert.equal(scope.resolve(write)(10), id + 10);
        assert.equal(scope.resolve(remove)(), id);
        assert.ok(Object.isFrozen(scope.resolve(readBinding)));
        assert.equal(scope.resolve(readBinding).read.reader, read);
        assert.equal(scope.resolve(readBinding).exists.reader, exists);
        assert.equal(scope.resolve(writeBinding).write.writer, write);
        assert.equal(scope.resolve(writeBinding).remove.writer, remove);
      });
      assert.equal(binds, id * 2);
    }
    assert.deepEqual(closed, [1, 2]);
  } finally {
    await app.stop();
  }
});

test("single-member compositions retain named binding objects", async () => {
  const read = reader<() => string>();
  const write = writer<() => string>();
  const reading = plug({
    port: reader.compose({ read }),
    bind: () => ({ read: () => "read" }),
  });
  const writing = plug({
    port: writer.compose({ write }),
    bind: () => ({ write: () => "write" }),
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { reading, writing } })] }),
  );
  try {
    await app.withScope((scope) => {
      assert.equal(scope.resolve(read)(), "read");
      assert.equal(scope.resolve(write)(), "write");
    });
  } finally {
    await app.stop();
  }
});

test("raw port arrays and malformed compositions fail before acquisition", () => {
  const read = reader<() => number>();
  const write = writer<() => number>();
  assert.throws(() => writer.compose({ write, duplicate: write }), /Duplicate/);
  assert.throws(() => writer.compose({}), /non-empty/);
  assert.throws(() => Reflect.apply(writer.compose, undefined, [{ read }]), /writers/);
  assert.throws(() => Reflect.apply(reader.compose, undefined, [{ write }]), /readers/);
  for (const port of [[], [read], [read, write], [reader.compose({ read })], [read, read], [[read]]]) {
    assert.throws(() => Reflect.apply(plug, undefined, [{ port, bind: () => [] }]), /one port/);
  }
});

test("each implementation is its port's own, and a composition names exactly its members", async () => {
  const read = reader<() => number>();
  const other = reader<() => number>();
  const group = reader.compose({ read, other });
  const cases: readonly { port: object; bind: () => unknown; error: RegExp }[] = [
    { port: read, bind: () => [], error: /must be a function/ },
    // A plug is not an implementation: its port rejects it.
    { port: read, bind: () => plug({ port: other, bind: () => () => 1 }), error: /must be a function/ },
    { port: read, bind: () => ({ run: () => 1 }), error: /must be a function/ },
    { port: read, bind: () => Promise.reject(new Error("invalid async bind")), error: /synchronous/ },
    { port: group, bind: () => [() => 1, () => 2], error: /named object/ },
    { port: group, bind: () => ({ read: () => 1 }), error: /missing/ },
    { port: group, bind: () => ({ read: () => 1, other: () => 2, extra: () => 3 }), error: /undeclared member/ },
    { port: group, bind: () => ({ read: () => 1, other: 2 }), error: /must be a function/ },
  ];
  for (const item of cases) {
    const binding = Reflect.apply(plug, undefined, [{ port: item.port, bind: item.bind }]) as PlugDefinition;
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] }));
    try {
      await assert.rejects(
        app.withScope((scope) => scope.resolve(read)),
        item.error,
      );
    } finally {
      await app.stop();
    }
  }
});

test("conflicting implementations fail before resource acquisition", async () => {
  const read = reader<() => number>();
  const first = plug({ port: read, requirements: {}, bind: () => () => 1 });
  const second = plug({ port: read, requirements: {}, bind: () => () => 2 });
  let acquisitions = 0;
  const shared = resource({
    initialize() {
      acquisitions++;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  for (const exports of [
    { first, second },
    { first, direct: plug({ port: read, bind: () => () => 3 }) },
  ]) {
    await assert.rejects(
      runApplication(
        defineApplication({
          modules: [composeModule({ providers: { ...exports, shared } })],
        }),
      ),
      /multiple implementations supplied for/,
    );
  }
  assert.equal(acquisitions, 0);
});

test("output declarations coexist with behavior operations and scheduler/listener invocation scopes", async () => {
  const find = reader<(id: string) => Promise<string>>();
  const save = writer<(value: string) => Promise<void>>();
  const output = {
    find: plug({
      port: find,
      requirements: {},
      bind: () => (id) => Promise.resolve(`role:${id}`),
    }),
    save: plug({
      port: save,
      requirements: {},
      bind: () => () => Promise.resolve(),
    }),
  };
  const load = operation<string>()({
    requirements: { find },
    run: async (id, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.find(id) } }),
  });
  const port = listener<string>()({
    requirements: { load, save },
    run: async (id, ctx) => {
      const result = await ctx.load(id);
      if (!result.isError) {
        await ctx.save(result.value.output.next);
      }
      return result;
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { ...output, port } })] }));
  assert.deepEqual(await app.resolve(port)({ input: "r1" }), {
    output: { changeType: "updated" as const, next: "role:r1" },
  });
  await app.stop();
});

test("hard exclusions, disabled modules and catalogues cannot reintroduce output members", async () => {
  const read = reader<() => number>();
  const write = reader<() => number>();
  const binding = plug({
    port: reader.compose({ read, write }),
    requirements: {},
    bind: () => ({ read: () => 1, write: () => 2 }),
  });
  const module = composeModule({ providers: { read, write, binding } });
  for (const view of [module.exclude([read]), module.exclude([binding]), module.when(false)]) {
    const app = await runApplication(defineApplication({ modules: module.requiredBy(view) }));
    await assert.rejects(
      app.withScope((scope) => scope.resolve(read)),
      /excluded|unavailable|The reader has no implementation/,
    );
    await app.stop();
  }
  const app = await runApplication(defineApplication({ modules: [module.exclude([read])] }));
  await app.withScope((scope) => assert.equal(scope.resolve(write)(), 2));
  await app.stop();
});

test("bindings remain lazy in dependency-only modules and includeOnly selections", async () => {
  const read = reader<() => number>();
  let binds = 0;
  const binding = plug({
    port: read,
    requirements: {},
    bind: () => {
      binds++;
      return () => 1;
    },
  });
  const dependencies = composeModule({ providers: { binding } });
  const selected = unit({ factory: () => 42 });
  const root = composeModule({ providers: { selected } }).includeOnly([selected]);
  const app = await runApplication(defineApplication({ modules: dependencies.requiredBy(root) }));
  assert.equal(binds, 0);
  assert.equal(app.resolve(selected), 42);
  await app.withScope((scope) => assert.equal(scope.resolve(read)(), 1));
  assert.equal(binds, 1);
  await app.stop();
});

test("overrides preserve member identity and app isolation", async () => {
  const read = reader<() => number>();
  const write = reader<() => number>();
  let binds = 0;
  const binding = plug({
    port: reader.compose({ read, write }),
    requirements: {},
    bind: () => {
      binds++;
      return { read: () => 1, write: () => 2 };
    },
  });
  const module = composeModule({ providers: { binding } });
  const definition = defineApplication({ modules: [module] });
  const app = await runApplication(definition, { overrides: [override(read, () => 10)] });
  const other = await runApplication(definition, { overrides: [override(read, () => 20)] });
  await app.withScope((scope) => {
    assert.equal(scope.resolve(read)(), 10);
    assert.equal(scope.resolve(write)(), 2);
  });
  await other.withScope((scope) => {
    assert.equal(scope.resolve(read)(), 20);
    assert.equal(scope.resolve(write)(), 2);
  });
  assert.equal(binds, 2);
  await Promise.all([app.stop(), other.stop()]);
});

test("contracts required by reachable definitions fail at startup with their declared names", async () => {
  const find = reader<() => number>();
  const save = writer<(value: number) => void>();
  const changes = publisher<number>();
  const check = operation({
    requirements: { find },
    run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find() } }),
  });
  const store = command({ requirements: { check, save, changes }, run: () => success() });
  const api = expose({ handler: store });
  const audit = listener({ requirements: { save }, run: () => success() });
  let acquisitions = 0;
  const shared = resource({
    initialize() {
      acquisitions++;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  await assert.rejects(
    runApplication(
      // @ts-expect-error The compiler reports the same unbound contracts; this checks the startup backstop.
      defineApplication({
        modules: [provideFlow([api, audit]), composeModule({ providers: { shared } })],
      }),
    ),
    (error: Error) => {
      assert.match(error.message, /writer 'save' has no implementation \(listener → save\)/);
      assert.match(error.message, /publisher 'changes' has no implementation \(expose → handler → changes\)/);
      assert.match(error.message, /reader 'find' has no implementation \(expose → handler → check → find\)/);
      return true;
    },
  );
  assert.equal(acquisitions, 0);
  const saving = composeModule({ providers: { binding: plug({ port: save, bind: () => () => {} }) } });
  const partial = await runApplication(
    defineApplication({ modules: [provideFlow([api, audit]).includeOnly([audit]), saving] }),
  );
  await partial.stop();
  const overridden = await runApplication(defineApplication({ modules: [provideFlow([api]), saving] }), {
    overrides: [
      override(find, () => 1),
      override(changes, { publish: () => Promise.resolve(), publishNow: () => Promise.resolve() }),
    ],
  });
  await overridden.stop();
});

test("reachable singletons are built at startup, so a failing factory stops startup and releases resources", async () => {
  const misconfigured = new Error("CLIENT_URL is not set");
  let built = 0;
  let released = 0;
  const shared = resource({
    initialize() {
      return Promise.resolve({
        value: 1,
        release() {
          released++;
        },
      });
    },
  });
  const failing = unit({
    factory: (): (() => number) => {
      throw misconfigured;
    },
  });
  const working = unit({
    factory: (): (() => number) => {
      built++;
      return () => 7;
    },
  });
  const port = (client: typeof working) =>
    expose({ handler: command({ requirements: { client }, run: (_, ctx) => success(ctx.client()) }) });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [provideFlow([port(failing)]), composeModule({ providers: { shared } })],
      }),
    ),
    (error) => error === misconfigured,
  );
  assert.equal(released, 1);
  const api = port(working);
  const app = await runApplication(defineApplication({ modules: [provideFlow([api])] }));
  try {
    assert.equal(built, 1);
    assert.deepEqual(await app.resolve(api)({ input: undefined }), 7);
    assert.equal(built, 1);
  } finally {
    await app.stop();
  }
});

test("decorations wrap plug-provided readers and writers without editing the plug", async () => {
  const calls: string[] = [];
  const saved: string[] = [];
  const find = reader<(id: string) => string>();
  const save = writer<(name: string) => void>();
  const storage = plug({
    port: writer.compose({ save }),
    bind: () => ({
      save: (name) => {
        saved.push(name);
      },
    }),
  });
  const lookup = plug({ port: find, bind: () => (id) => `role ${id}` });
  const log = unit({ factory: () => calls });
  const tracedFind = decorate(find, {
    requirements: { log },
    wrap:
      (inner, { log }) =>
      (id) => {
        log.push(id);
        return inner(id);
      },
  });
  const tracedSave = decorate(save, {
    requirements: { log },
    wrap:
      (inner, { log }) =>
      (name) => {
        log.push(name);
        return inner(name);
      },
  });
  const rename = command<string>()({
    requirements: { find, save },
    run: (id, ctx) => success(ctx.save(ctx.find(id))),
  });
  const api = expose({ handler: rename });
  const plugs = composeModule({ providers: { storage, lookup } });
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([api]), plugs, composeModule({ providers: { tracedFind, tracedSave } })],
    }),
  );
  try {
    assert.deepEqual(await app.resolve(api)({ input: "r1" }), undefined);
    assert.deepEqual(calls, ["r1", "role r1"]);
    assert.deepEqual(saved, ["role r1"]);
  } finally {
    await app.stop();
  }
  const cache = reader<() => Map<string, string>>();
  const cached = decorate(find, {
    requirements: { cache },
    wrap:
      (inner, { cache }) =>
      (id) =>
        cache().get(id) ?? inner(id),
  });
  await assert.rejects(
    runApplication(
      // @ts-expect-error A decoration requirement is a need like any other.
      defineApplication({ modules: [provideFlow([api]), plugs, composeModule({ providers: { cached } })] }),
    ),
    /reader 'cache' has no implementation \(expose → handler → find → cache\)/,
  );
});

test("scoped output adapters reject singleton capture and missing implementations fail as DI errors", async () => {
  const read = reader<() => number>();
  const binding = plug({ port: read, requirements: {}, bind: () => () => 1 });
  const singleton = unit({ requirements: { read }, factory: ({ read }) => read });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { binding, singleton } })] })),
    /shorter lifetime/,
  );
  const write = writer<() => number>();
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { write } })] }));
  await assert.rejects(
    app.withScope((scope) => scope.resolve(write)),
    /The writer has no implementation/,
  );
  await app.stop();
  const scoped = unit({ factory: () => 1, lifetime: "scoped" });
  const capturesScoped = plug({
    port: read,
    requirements: { scoped },
    bind:
      ({ scoped }) =>
      () =>
        scoped,
  });
  const root = unit({ requirements: { read }, factory: ({ read }) => read });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { capturesScoped, root } })] })),
    /shorter lifetime/,
  );
});

test("standalone and grouped bindings retain business errors and infrastructure rejections", async () => {
  const expected = new Error("business failure");
  const defect = new Error("database unavailable");
  const read = reader<() => Promise<never>>();
  const write = writer<() => { readonly error: Error }>();
  const binding = {
    read: plug({
      port: read,
      requirements: {},
      bind: () => () => Promise.reject(defect),
    }),
    write: plug({
      port: write,
      requirements: {},
      bind: () => () => ({ error: expected }),
    }),
  };
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { ...binding } })] }));
  await app.withScope(async (scope) => {
    await assert.rejects(scope.resolve(read)(), (error) => error === defect);
    assert.equal(scope.resolve(write)().error, expected);
  });
  await app.stop();
});

test("private output adapters in explicit requirement graphs register their member implementations", async () => {
  const read = reader<() => number>();
  const output = plug({ port: read, requirements: {}, bind: () => () => 42 });
  const parent = unit({ requirements: { output }, factory: () => true, lifetime: "scoped" });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { parent } }).includeOnly([])] }),
  );
  await app.withScope((scope) => {
    assert.equal(scope.resolve(read)(), 42);
    assert.equal(scope.resolve(parent), true);
  });
  await app.stop();
});

const memberReference: Definition = reader<() => void>();
void memberReference;
