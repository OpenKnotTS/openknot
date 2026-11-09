import type { InputInvoker, UowCommitted } from "../src/index.ts";
import {
  broadcast,
  command,
  defaultUnitOfWork,
  expose,
  guard,
  hook,
  listener,
  publisher,
  query,
  scheduler,
  topic,
  unitOfWork,
  writer,
} from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { operation, reader, success } from "@openknot-ts/behavior";
import { provideBehavior } from "@openknot-ts/behavior/wire";
import {
  plug,
  hook as applicationHook,
  collect,
  override,
  resource,
  runApplication,
  defineApplication,
  composeModule,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role {
  readonly id: string;
  readonly name: string;
}

test("a behavior-only reader binds directly in infrastructure with no flow declaration or manual bridge", async () => {
  const find = reader<(id: string) => Promise<Role>>();
  const rename = operation<{ readonly id: string; readonly name: string }>()({
    requirements: { find },
    run: async (input, ctx) => {
      const role = await ctx.find(input.id);
      return success({ output: { changeType: "updated" as const, next: { ...role, name: input.name } } });
    },
  });
  const database = unit({
    factory: () => ({
      find: (id: string) => Promise.resolve({ id, name: "Original" }),
    }),
  });
  const data = plug({
    port: find,
    requirements: { database },
    bind: ({ database }) => database.find,
  });
  const app = await runApplication(
    defineApplication({
      modules: [provideBehavior([rename]), composeModule({ providers: { data } })],
    }),
  );
  try {
    await app.withScope(async (scope) => {
      assert.deepEqual(
        await scope.resolve(rename)({ id: "r1", name: "Dispatcher" }),
        success({
          output: { changeType: "updated" as const, next: { id: "r1", name: "Dispatcher" } },
        }),
      );
    });
  } finally {
    await app.stop();
  }
});

test("flow compositions keep source lifecycle automatic and build bindings without per-request requirements once", async () => {
  let bindings = 0;
  let releases = 0;
  const saved: Role[] = [];
  const find = reader<(id: string) => Promise<Role>>();
  const save = writer<(role: Role) => Promise<void>>();
  const rename = operation<Role>()({
    requirements: { find },
    run: async (input, ctx) =>
      success({
        output: { changeType: "updated" as const, next: { ...(await ctx.find(input.id)), name: input.name } },
      }),
  });
  const onRename = listener<Role>()({
    requirements: { rename, save },
    run: async (input, ctx) => {
      const result = await ctx.rename(input);
      if (result.isError) {
        return result;
      }
      await ctx.save(result.value.output.next);
      return success(result.value.output.next);
    },
  });
  const data = {
    readers: plug({
      port: reader.compose({ find }),
      requirements: {},
      bind: () => {
        bindings += 1;
        return { find: (id) => Promise.resolve({ id, name: "Original" }) };
      },
    }),
    writers: plug({
      port: writer.compose({ save }),
      requirements: {},
      bind: () => {
        bindings += 1;
        return {
          save: (role) => {
            saved.push(role);
            return Promise.resolve();
          },
        };
      },
    }),
  };
  let receive: InputInvoker<typeof onRename> | undefined;
  const source = plug({
    port: onRename,
    requirements: {},
    bind: ({ invoke }) => {
      receive = invoke;
      return {
        release() {
          releases += 1;
        },
      };
    },
  });
  // rename is private to this graph: only the listener and writer are public ports.
  const ports = provideFlow([onRename, writer.compose({ save })]);
  const infrastructure = composeModule({ providers: { ...data, source } });
  const app = await runApplication(defineApplication({ modules: [ports, infrastructure] }));
  try {
    assert.equal(bindings, 0);
    assert.ok(receive);
    assert.deepEqual(await receive({ input: { id: "r1", name: "Dispatcher" } }), { id: "r1", name: "Dispatcher" });
    assert.deepEqual(await receive({ input: { id: "r2", name: "Supervisor" } }), { id: "r2", name: "Supervisor" });
    assert.equal(bindings, 2);
    assert.deepEqual(
      saved.map(({ id }) => id),
      ["r1", "r2"],
    );
  } finally {
    await app.stop();
  }
  assert.equal(releases, 1);
});

test("flow composition accepts individual ports, namespace imports and independent compositions", async () => {
  const count = reader<() => number>();
  const save = writer<(value: number) => void>();
  const readPorts = reader.compose({ count });
  const writePorts = writer.compose({ save });
  const ports = provideFlow([count, readPorts, { save }, writePorts, () => import("./fixtures/ports.ts")]).includeOnly([
    save,
  ]);
  const data = {
    reading: plug({ port: readPorts, bind: () => ({ count: () => 7 }) }),
    writing: plug({ port: writePorts, bind: () => ({ save: () => undefined }) }),
  };
  const app = await runApplication(
    defineApplication({
      modules: [ports, composeModule({ providers: { ...data } })],
    }),
  );
  try {
    const { onNumber } = await import("./fixtures/ports.ts");
    assert.deepEqual(await app.resolve(onNumber)({ input: 12 }), 12);
    await app.withScope((scope) => assert.equal(scope.resolve(count)(), 7));
  } finally {
    await app.stop();
  }
});

test("flow provisions accept all input/output ports and native units through every source form", async () => {
  const count = unit({ factory: () => 7 });
  const scoped = unit({ lifetime: "scoped", requirements: { count }, factory: ({ count }) => ({ count }) });
  const access = guard<string>()({ run: (_token) => success() });
  const read = reader<() => number>();
  const save = writer<(value: number) => void>();
  const events = publisher<number>();
  const changes = topic<string, number>()({ guards: { access } });
  const messages = broadcast<number>()({});
  const action = command({ requirements: { scoped }, run: (_, ctx) => success(ctx.scoped.count) });
  const endpoint = expose({ requirements: { command: action }, run: (_, ctx) => ctx.command() });
  const onMessage = listener<number>()({ run: (input) => success(input) });
  const tick = scheduler({ schedule: { every: { seconds: 1 } }, run: () => success() });
  const entries = { count, scoped, read, save, events, changes, messages, endpoint, onMessage, tick };
  for (const flow of [
    provideFlow(Object.values(entries)),
    provideFlow([entries]),
    provideFlow([async () => entries]),
  ]) {
    const app = await runApplication(defineApplication({ modules: [flow] }), { overrides: [override(count, 9)] });
    try {
      assert.equal(app.resolve(count), 9);
      assert.throws(() => app.resolve(scoped), /withScope/);
      assert.deepEqual(await app.resolve(endpoint)({ input: undefined }), 9);
      assert.deepEqual(await app.resolve(onMessage)({ input: 3 }), 3);
      assert.deepEqual(await app.resolve(tick)({ trigger: { scheduledAt: Date.now() } }), undefined);
      const first = await app.withScope((scope) => {
        const resolved = scope.resolve(scoped);
        assert.equal(resolved, scope.resolve(scoped));
        return resolved;
      });
      const second = await app.withScope((scope) => scope.resolve(scoped));
      assert.notEqual(first, second);
      assert.deepEqual(second, { count: 9 });
    } finally {
      await app.stop();
    }
  }
  const selected = await runApplication(
    defineApplication({ modules: [provideFlow([count, scoped]).includeOnly([count]).exclude([scoped])] }),
  );
  try {
    assert.equal(selected.resolve(count), 7);
    await assert.rejects(
      selected.withScope((scope) => scope.resolve(scoped)),
      /unavailable|excluded/,
    );
  } finally {
    await selected.stop();
  }
  // A scoped root is built in each scope, like any scoped dependency.
  const scopedRoot = await runApplication(
    defineApplication({ modules: [provideFlow([count, scoped]).includeOnly([scoped])] }),
  );
  try {
    assert.deepEqual(await scopedRoot.withScope((scope) => scope.resolve(scoped)), { count: 7 });
  } finally {
    await scopedRoot.stop();
  }
});

test("flow provisions reject internal definitions, bindings and lifecycle providers through every source form", async () => {
  const find = reader<() => number>();
  for (const source of ["./ports", { href: "file:///ports/" }, find, null, 42]) {
    assert.throws(() => Reflect.apply(provideFlow, undefined, [source]), /expects an array/);
  }
  const run = operation({
    requirements: {},
    run: () => success({ output: { changeType: "updated" as const, next: 1 } }),
  });
  const data = plug({
    port: find,
    requirements: {},
    bind: () => () => 1,
  });
  const action = command({ run: () => success() });
  const lookup = query({ run: () => success(1) });
  const access = guard({ run: () => success() });
  const committed = hook<UowCommitted>()({ run: (_event) => success() });
  const transaction = unitOfWork({ hooks: { afterCommit: [committed] } });
  const native = { transaction: <T>(work: () => Promise<T>) => work() };
  const events = publisher<number>();
  const changes = topic<string, number>()({});
  const messages = broadcast<number>()({});
  let initialized = 0;
  const database = resource({
    async initialize() {
      initialized++;
      return { value: 1, release() {} };
    },
  });
  for (const value of [
    run,
    operation.compose({ run }),
    data,
    plug({ port: find, bind: () => () => 1 }),
    action,
    lookup,
    access,
    committed,
    transaction,
    defaultUnitOfWork,
    plug({ port: transaction, bind: () => native }),
    plug({ port: events, bind: () => () => {} }),
    plug({ port: changes, bind: () => ({ publish() {}, subscribe: async function* () {} }) }),
    plug({ port: messages, bind: () => ({ publish() {}, subscribe: async function* () {} }) }),
    database,
    applicationHook({ run() {} }),
    collect.contract<number>(),
    { run },
  ]) {
    assert.throws(() => Reflect.apply(provideFlow, undefined, [[value]]), /invalid|does not accept/);
    assert.throws(() => Reflect.apply(provideFlow, undefined, [[{ invalid: value }]]), /invalid export 'invalid'/);
    const imported = Reflect.apply(provideFlow, undefined, [[async () => ({ invalid: value })]]) as ReturnType<
      typeof provideFlow
    >;
    await assert.rejects(runApplication(defineApplication({ modules: [imported] })), /invalid export 'invalid'/);
  }
  assert.equal(initialized, 0);
});

test("native imported scheduler ports retain schedule metadata and ordinary invocation semantics", async () => {
  const tick = scheduler({
    schedule: { every: { seconds: 1 } },
    requirements: {},
    run: () => success(1),
  });
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([async () => ({ tick })])],
    }),
  );
  try {
    assert.deepEqual(await app.resolve(tick)({ trigger: { scheduledAt: Date.now() } }), 1);
  } finally {
    await app.stop();
  }
});
