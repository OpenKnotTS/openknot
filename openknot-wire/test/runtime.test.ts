import type { ApplicationOptions, Definition, ExecutionScope, ModuleExports } from "@openknot-ts/wire";
import {
  runApplication,
  decorate,
  defineApplication,
  composeModule,
  override,
  requiredBy,
  resource,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

function start(providers: ModuleExports, options: Omit<ApplicationOptions, "modules"> = {}) {
  return runApplication(defineApplication({ modules: [composeModule({ providers })], ...options }));
}

test("includeOnly chooses roots, leaves dependencies available, and does not mutate the module", async () => {
  let created = 0;
  const repository = unit({ factory: () => ({ id: ++created }) });
  const handler = unit({
    requirements: { repository },
    factory: ({ repository }: { repository: { id: number } }) => ({ repository }),
  });
  const dormant = unit({
    factory: () => {
      throw new Error("must not instantiate");
    },
  });
  const module = composeModule({ providers: { repository, handler, dormant, ignored: 123 } });
  const selected = module.includeOnly([handler]);
  assert.equal(module.roots.length, 3);
  assert.equal(selected.definitions.length, 3);
  assert.equal(selected.roots.length, 1);
  const definition = defineApplication({ modules: requiredBy(selected) });
  const first = await runApplication(definition);
  const second = await runApplication(definition);
  try {
    assert.equal(first.resolve(handler).repository, first.resolve(repository));
    assert.equal(first.resolve(handler), first.resolve(handler));
    assert.notEqual(first.resolve(repository), second.resolve(repository));
    assert.equal(created, 2);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("requiredBy preserves composition while references discover private dependencies", async () => {
  const command = unit({ factory: () => ({ run: (name: string) => ({ name }) }) });
  const query = unit({ factory: () => ({ run: (id: string) => ({ id }) }) });
  const api = unit({
    requirements: { command, query },
    factory: ({
      command,
      query,
    }: {
      command: { run(name: string): { name: string } };
      query: { run(id: string): { id: string } };
    }) => ({ create: command.run, find: query.run }),
  });
  const commands = composeModule({ providers: { command, query } });
  const application = composeModule({ providers: { api } });
  const app = await runApplication(defineApplication({ modules: commands.requiredBy(application) }));
  try {
    assert.deepEqual(app.resolve(api).create("Role"), { name: "Role" });
    assert.deepEqual(app.resolve(api).find("42"), { id: "42" });
  } finally {
    await app.stop();
  }
  const direct = await runApplication(defineApplication({ modules: requiredBy(application) }));
  assert.deepEqual(direct.resolve(api).find("42"), { id: "42" });
  await direct.stop();
});

test("excluded providers and disabled modules cannot be reintroduced by another module", async () => {
  const dependency = unit({ factory: () => 42 });
  const consumer = unit({
    requirements: { dependency },
    factory: ({ dependency }: { dependency: number }) => dependency,
  });
  const dependencies = composeModule({ providers: { dependency } });
  const consumers = composeModule({ providers: { consumer } });
  const all = composeModule({ modules: [dependencies, consumers] });
  for (const excluded of [all.exclude([dependency]), all.exclude([dependencies]), dependencies.when(false)]) {
    await assert.rejects(
      runApplication(
        defineApplication({
          modules: all.requiredBy(excluded.includeOnly([]), consumers),
        }),
      ),
      /excluded|unavailable/,
    );
  }
  assert.throws(() => consumers.includeOnly([dependency]), /outside/);
});

test("export names and aliases do not affect dependency identity or duplicate construction", async () => {
  let calls = 0;
  const first = unit({ factory: () => ({ id: ++calls }) });
  const second = unit({ factory: () => ({ id: ++calls }) });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({ providers: { thing: first, alias: first } }),
        composeModule({ providers: { thing: second } }),
      ],
    }),
  );
  try {
    assert.notEqual(app.resolve(first), app.resolve(second));
    assert.equal(app.resolve(first), app.resolve(first));
    assert.equal(calls, 2);
  } finally {
    await app.stop();
  }
});

test("module export names never become container registration names", async () => {
  const thing = unit({ factory: () => 1 });
  for (const key of ["__proto__", "constructor", "then", "applicationState", "toString"]) {
    const app = await start({ [key]: thing });
    try {
      assert.equal(app.resolve(thing), 1);
    } finally {
      await app.stop();
    }
  }
});

test("unrecognized requirement references fail without invoking the consumer factory", async () => {
  let calls = 0;
  const missing = {} as Definition;
  const consumer = unit({
    requirements: { missing },
    factory: () => {
      calls++;
      return 1;
    },
  });
  await assert.rejects(start({ consumer }), /unavailable|adapter/);
  assert.equal(calls, 0);
});

test("factories capture immutable resolved dependencies and still reject async construction", async () => {
  const value = unit({ factory: () => 42 });
  const capture = unit({
    requirements: { value },
    factory: (dependencies) => ({
      later: () => dependencies.value,
      dependencies,
    }),
  });
  const app = await start({ capture });
  try {
    assert.equal(app.resolve(capture).later(), 42);
    assert.ok(Object.isFrozen(app.resolve(capture).dependencies));
  } finally {
    await app.stop();
  }
  const asyncFactory = unit({
    factory: async () => {
      throw new Error("async rejection is observed");
    },
  });
  await assert.rejects(start({ asyncFactory }), /Factories must be synchronous/);
});

test("requirements may be omitted but every declared dependency is required even when unused", async () => {
  const independent = unit({ factory: () => "none" });
  assert.deepEqual(independent.requirements, {});
  assert.ok(Object.isFrozen(independent.requirements));
  const app = await start({ independent });
  try {
    assert.equal(app.resolve(independent), "none");
  } finally {
    await app.stop();
  }
  const broken = unit({
    factory: () => {
      throw new Error("required provider failed");
    },
  });
  const consumer = unit({ requirements: { broken }, factory: () => "unused" });
  await assert.rejects(start({ consumer }), /required provider failed/);
});

test("configuration is provided by reference and externally owned values are not released", async () => {
  let released = false;
  const settings = {
    url: "memory:",
    release() {
      released = true;
    },
  };
  const config = unit({ factory: () => settings });
  const consumer = unit({ requirements: { config }, factory: ({ config }) => config.url });
  const app = await start({ consumer });
  try {
    assert.equal(app.resolve(consumer), "memory:");
  } finally {
    await app.stop();
  }
  assert.equal(released, false);
});

test("bindings and overrides preserve the original reference", async () => {
  const original = unit({ factory: () => ({ name: "original" }) });
  const binding = unit({ provides: original, factory: () => ({ name: "binding" }) });
  const app = await start({ original, binding });
  assert.equal(app.resolve(original).name, "binding");
  await app.stop();
  const overridden = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { original } })] }),
    {
      overrides: [override(original, { name: "stub" })],
    },
  );
  assert.equal(overridden.resolve(original).name, "stub");
  await overridden.stop();
});

test("scopes cache scoped providers, isolate operations, and expire their resolve handle", async () => {
  let id = 0;
  const scoped = unit({ factory: () => ({ id: ++id }), lifetime: "scoped" });
  const transient = unit({ factory: () => ({}), lifetime: "transient" });
  const module = composeModule({ providers: { scoped, transient } }).includeOnly([]);
  const app = await runApplication(defineApplication({ modules: requiredBy(module) }));
  let captured: ExecutionScope | undefined;
  const first = await app.withScope((scope) => {
    captured = scope;
    assert.equal(scope.resolve(scoped), scope.resolve(scoped));
    assert.notEqual(scope.resolve(transient), scope.resolve(transient));
    return scope.resolve(scoped);
  });
  const second = await app.withScope((scope) => scope.resolve(scoped));
  assert.notEqual(first, second);
  assert.throws(() => captured?.resolve(scoped), /closed/);
  assert.throws(() => app.resolve(scoped), /withScope/);
  await app.stop();
  assert.throws(() => app.resolve(transient), /stopped/);
  await assert.rejects(
    app.withScope(() => undefined),
    /stopped/,
  );
});

test("a transient over a scoped dependency resolves only inside a scope, which owns the scoped value", async () => {
  let id = 0;
  const session = unit({ lifetime: "scoped", factory: () => ({ id: ++id }) });
  const view = unit({ lifetime: "transient", requirements: { session }, factory: ({ session }) => session });
  const app = await runApplication(
    defineApplication({ modules: requiredBy(composeModule({ providers: { session, view } }).includeOnly([])) }),
  );
  try {
    assert.throws(() => app.resolve(view), /withScope/);
    const [first, second] = await Promise.all([
      app.withScope((scope) => [scope.resolve(view), scope.resolve(view)]),
      app.withScope((scope) => scope.resolve(view)),
    ]);
    assert.equal(first[0], first[1]);
    assert.notEqual(first[0], second);
  } finally {
    await app.stop();
  }
});

test("strict lifetimes reject singleton capture of scoped dependencies", async () => {
  const scoped = unit({ factory: () => ({}), lifetime: "scoped" });
  const singleton = unit({ requirements: { scoped }, factory: ({ scoped }: { scoped: object }) => scoped });
  const module = composeModule({ providers: { scoped, singleton } });
  await assert.rejects(
    runApplication(defineApplication({ modules: requiredBy(module.includeOnly([singleton])) })),
    /shorter lifetime/,
  );
});

test("a scoped root is validated at startup and built in each scope", async () => {
  const count = unit.contract<number>();
  const scoped = unit({ lifetime: "scoped", requirements: { count }, factory: ({ count }) => ({ count }) });
  const definition = defineApplication({ modules: [composeModule({ providers: { scoped } })] });
  // @ts-expect-error The scoped root's contract needs an implementation.
  await assert.rejects(runApplication(definition), /unit 'count' has no implementation \(unit 'scoped' → count\)/);
  const app = await runApplication(definition, { overrides: [override(count, 1)] });
  try {
    assert.throws(() => app.resolve(scoped), /withScope/);
    const [first, second] = await app.withScope((scope) => [scope.resolve(scoped), scope.resolve(scoped)]);
    assert.equal(first, second);
    assert.notEqual(await app.withScope((scope) => scope.resolve(scoped)), first);
  } finally {
    await app.stop();
  }
});

test("lifetime violations fail at startup with names, before anything resolves them", async () => {
  const session = unit({ factory: () => ({}), lifetime: "scoped" });
  const view = unit({ lifetime: "transient", requirements: { session }, factory: ({ session }) => session });
  const cache = unit({ requirements: { session }, factory: ({ session }) => session });
  const report = unit({ requirements: { view }, factory: ({ view }) => view });
  let acquisitions = 0;
  const shared = resource({
    initialize() {
      acquisitions++;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  // Neither cache nor report is a root: before, they failed only once something resolved them.
  const module = composeModule({ providers: { cache, report, shared } }).includeOnly([]);
  await assert.rejects(runApplication(defineApplication({ modules: requiredBy(module) })), (error: Error) => {
    assert.match(
      error.message,
      /singleton unit 'cache' depends on scoped unit 'session', which has a shorter lifetime/,
    );
    assert.match(
      error.message,
      /singleton unit 'report' depends on scoped unit 'session' through transient unit 'view', which has a shorter lifetime/,
    );
    return true;
  });
  assert.equal(acquisitions, 0);
});

test("a transient keeps no lifetime of its own: it lives as long as the consumer that keeps it", async () => {
  let built = 0;
  const logger = unit({ lifetime: "transient", factory: () => ({ id: ++built }) });
  const service = unit({ requirements: { logger }, factory: ({ logger }) => logger });
  const other = unit({ requirements: { logger }, factory: ({ logger }) => logger });
  const session = unit({ lifetime: "scoped", factory: () => ({}) });
  const view = unit({ lifetime: "transient", requirements: { session }, factory: ({ session }) => ({ session }) });
  const request = unit({ lifetime: "scoped", requirements: { view, session }, factory: (values) => values });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { service, other, request } })] }),
  );
  try {
    // Each singleton consumer keeps its own logger instance.
    assert.notEqual(app.resolve(service), app.resolve(other));
    assert.equal(app.resolve(service), app.resolve(service));
    // A scoped consumer keeps a transient over the scope's own scoped value.
    await app.withScope((scope) => {
      const { view, session } = scope.resolve(request);
      assert.equal(view.session, session);
    });
  } finally {
    await app.stop();
  }
  // A singleton may not keep a scoped value through transients, however many, nor through a decoration.
  const outer = unit({ lifetime: "transient", requirements: { view }, factory: ({ view }) => view });
  const cache = unit({ requirements: { outer }, factory: ({ outer }) => outer });
  const decorated = decorate(service, { requirements: { view }, wrap: (inner) => inner });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { cache, service, decorated } })] })),
    (error: Error) => {
      assert.match(
        error.message,
        /singleton unit 'cache' depends on scoped unit 'session' through transient unit 'outer' → transient unit 'view'/,
      );
      assert.match(
        error.message,
        /decoration of singleton unit 'service' depends on scoped unit 'session' through transient unit 'view'/,
      );
      return true;
    },
  );
});

test("application definitions snapshot mutable input arrays", async () => {
  const provider = unit({ factory: () => 42 });
  const modules = [composeModule({ providers: { provider } })];
  const definition = defineApplication({ modules });
  modules.length = 0;
  const app = await runApplication(definition);
  assert.equal(app.resolve(provider), 42);
  await app.stop();
});
