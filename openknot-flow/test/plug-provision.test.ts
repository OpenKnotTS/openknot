import { command, defaultUnitOfWork, expose, listener, writer } from "../src/index.ts";
import type { InputInvoker } from "../src/index.ts";
import type {} from "../src/wire.ts";
import { operation, reader, success } from "@openknot-ts/behavior";
import {
  plug,
  collect,
  defineApplication,
  hook,
  providePlugs,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("plug provisions activate native sources before startup tasks and release them after shutdown tasks", async () => {
  const order: string[] = [];
  const config = unit({ factory: () => 7 });
  const database = resource({
    requirements: { config },
    async initialize({ config }) {
      order.push("resource:open");
      return {
        value: { saved: config },
        release() {
          order.push("resource:close");
        },
      };
    },
  });
  const save = writer<(value: number) => void>();
  const action = command<number>()({
    requirements: { save },
    run: (value, ctx) => {
      ctx.save(value);
      return success();
    },
  });
  const received = listener<number>()({
    requirements: { command: action },
    run: (value, ctx) => ctx.command(value),
  });
  const data = plug({
    port: save,
    requirements: { database },
    bind:
      ({ database }) =>
      (value) => {
        database.saved = value;
      },
  });
  let invoke: InputInvoker<typeof received> | undefined;
  const consumer = plug({
    port: received,
    bind: (ctx) => {
      invoke = ctx.invoke;
      order.push("source:start");
      return {
        release() {
          order.push("source:stop");
        },
      };
    },
  });
  const start = hook({
    requirements: { database },
    async run({ database }) {
      assert.ok(invoke);
      assert.deepEqual(await invoke({ input: 42 }), undefined);
      assert.equal(database.saved, 42);
      order.push("startup");
    },
  });
  const stop = hook({
    requirements: { database },
    run({ database }) {
      assert.equal(database.saved, 42);
      order.push("shutdown");
    },
  });
  const entries = { config, database, data, consumer };
  for (const provided of [
    providePlugs(Object.values(entries)),
    providePlugs([entries]),
    providePlugs([async () => entries]),
  ]) {
    order.length = 0;
    const app = await runApplication(
      defineApplication({
        modules: [provided],
        startupTasks: [start],
        shutdownTasks: [stop],
      }),
    );
    assert.deepEqual(order, ["resource:open", "source:start", "startup"]);
    await app.stop();
    assert.deepEqual(order, ["resource:open", "source:start", "startup", "shutdown", "source:stop", "resource:close"]);
  }
  order.length = 0;
  const disabled = await runApplication(defineApplication({ modules: [providePlugs([consumer]).when(false)] }));
  try {
    assert.deepEqual(order, []);
  } finally {
    await disabled.stop();
  }
});

test("plug provision rejects contracts and application hooks through every source form", async () => {
  const read = reader<() => number>();
  const run = operation({ run: () => success({ output: { changeType: "updated" as const, next: 1 } }) });
  for (const value of [
    read,
    run,
    command({ run: () => success() }),
    expose({ run: () => success() }),
    listener({ run: () => success() }),
    defaultUnitOfWork,
    hook({ run() {} }),
    collect.contract<number>(),
  ]) {
    for (const source of [[value], [{ invalid: value }]]) {
      assert.throws(() => Reflect.apply(providePlugs, undefined, [source]), /invalid|does not accept/);
    }
    const imported = Reflect.apply(providePlugs, undefined, [[async () => ({ invalid: value })]]) as ReturnType<
      typeof providePlugs
    >;
    await assert.rejects(runApplication(defineApplication({ modules: [imported] })), /invalid export 'invalid'/);
  }
});

test("plug provision preserves selectors and dependency-only activation", async () => {
  let starts = 0;
  const input = listener({ run: () => success() });
  const binding = plug({
    port: input,
    bind: () => {
      starts++;
      return { release() {} };
    },
  });
  const dependency = unit({ factory: () => 42 });
  const provision = providePlugs([binding, dependency]);
  const selected = provision.includeOnly([dependency]);
  const app = await runApplication(defineApplication({ modules: provision.requiredBy(selected) }));
  try {
    assert.equal(app.resolve(dependency), 42);
    assert.equal(starts, 0);
  } finally {
    await app.stop();
  }
  const excluded = await runApplication(defineApplication({ modules: [provision.exclude([binding])] }));
  try {
    assert.equal(starts, 0);
    assert.throws(() => excluded.resolve(binding), /unavailable|excluded/);
  } finally {
    await excluded.stop();
  }
});
