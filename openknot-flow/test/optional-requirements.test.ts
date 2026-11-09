import { expose, guard, listener, query, scheduler } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { reader, success } from "@openknot-ts/behavior";
import { plug, runApplication, composeModule, defineApplication, optional } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("guards, inputs and both plug kinds may omit requirements without changing scope or port contracts", async () => {
  const signals: AbortSignal[] = [];
  const access = guard<string>()({
    run: (_input, ctx) => {
      signals.push(ctx.signal);
      return success();
    },
  });
  const publicPort = expose<string>()({ run: (input) => success(input) });
  const protectedPort = expose<number>()({ guards: { access }, run: (input) => success(input) });
  const messages = listener({ run: (_input, ctx) => success(ctx.trigger.attempt === undefined) });
  const tick = scheduler({
    schedule: { every: { seconds: 1 } },
    run: (_input, ctx) => success(typeof ctx.trigger.scheduledAt === "number"),
  });
  const read = reader<() => string>();
  const storage = plug({ port: read, bind: () => () => "stored" });
  const data = expose({ requirements: { read }, run: (_input, ctx) => success(ctx.read()) });
  let released = false;
  const transport = plug({
    port: publicPort,
    bind: async ({ invoke }) => {
      assert.deepEqual(await invoke({ input: "startup delivery" }), "startup delivery");
      return {
        release() {
          released = true;
        },
      };
    },
  });
  assert.ok(
    [access, publicPort, protectedPort, messages, tick, storage, transport].every(
      (definition) => Object.isFrozen(definition.requirements) && Object.keys(definition.requirements).length === 0,
    ),
  );
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([publicPort, protectedPort, messages, tick, data]),
        composeModule({ providers: { storage, transport } }),
      ],
    }),
  );
  try {
    assert.deepEqual(await app.resolve(publicPort)({ input: "public" }), "public");
    assert.deepEqual(await app.resolve(protectedPort)({ input: 42, access: "actor" }), 42);
    assert.deepEqual(await app.resolve(messages)({ input: undefined }), true);
    assert.deepEqual(await app.resolve(tick)({ trigger: { scheduledAt: 0 } }), true);
    assert.deepEqual(await app.resolve(data)({ input: undefined }), "stored");
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    await app.stop();
  }
  assert.equal(released, true);
});

test("an optional contract that is listed but unbound is absent, exactly like an unlisted one", async () => {
  const find = reader<(id: string) => string>();
  const lookup = query<string>()({
    requirements: { find: optional(find) },
    run: (id, ctx) => success(ctx.find === undefined ? "absent" : ctx.find(id)),
  });
  const api = expose({ handler: lookup });
  const binding = composeModule({ providers: { binding: plug({ port: find, bind: () => (id) => `role ${id}` }) } });
  for (const [modules, expected] of [
    [[provideFlow([api])], "absent"],
    [[provideFlow([api, find])], "absent"],
    [[provideFlow([api, find]), binding], "role r1"],
  ] as const) {
    const app = await runApplication(defineApplication({ modules: [...modules] }));
    try {
      assert.deepEqual(await app.resolve(api)({ input: "r1" }), expected);
      await app.withScope((scope) => assert.equal(scope.resolve(optional(find)) === undefined, expected === "absent"));
    } finally {
      await app.stop();
    }
  }
});
