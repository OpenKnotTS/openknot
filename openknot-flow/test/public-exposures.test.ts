import { expose, guard, InternalFlowError } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { failure, success } from "@openknot-ts/behavior";
import { plug, runApplication, composeModule, defineApplication, override, resource, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("unguarded public exposures retain input typing, scoped resources, cancellation signals and input adapters", async () => {
  const released: number[] = [];
  const signals: AbortSignal[] = [];
  let acquisitions = 0;
  let routeReleased = false;
  const session = resource({
    initialize: () => {
      const id = ++acquisitions;
      return Promise.resolve({
        value: id,
        release() {
          released.push(id);
        },
      });
    },
    lifetime: "scoped",
  });
  const port = expose<string>()({
    requirements: { session },
    run: (name, ctx) => {
      signals.push(ctx.signal);
      return success({ name, session: ctx.session });
    },
  });
  const explicitEmpty = expose<number>()({ requirements: {}, guards: {}, run: (id) => success(id) });
  const route = plug({
    port,
    requirements: {},
    bind: async ({ invoke }) => {
      assert.deepEqual(await invoke({ input: "from-plug" }), { name: "from-plug", session: 1 });
      return {
        release() {
          routeReleased = true;
        },
      };
    },
  });
  assert.deepEqual(port.guards, {});
  assert.ok(Object.isFrozen(port.guards));
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([expose.compose({ port, explicitEmpty })]), composeModule({ providers: { route } })],
    }),
  );
  try {
    assert.deepEqual(await app.resolve(port)({ input: "direct" }), { name: "direct", session: 2 });
    assert.deepEqual(await app.resolve(port)({ input: "empty-inputs" }), { name: "empty-inputs", session: 3 });
    assert.deepEqual(await app.resolve(explicitEmpty)({ input: 4 }), 4);
    for (const guards of [{ unknown: undefined }, null, [], undefined]) {
      await assert.rejects(
        Reflect.apply(app.resolve(port), undefined, [{ input: "invalid", guards }]),
        (error) => InternalFlowError.is(error) && error.cause instanceof TypeError,
      );
    }
    // The exposure without requirements executes without acquiring the session.
    assert.deepEqual(released, [1, 2, 3]);
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    await app.stop();
  }
  assert.equal(routeReleased, true);
});

test("the same guard definition is reused by multiple exposures with independent names and execution scopes", async () => {
  const checked: string[] = [];
  let serial = 0;
  const session = unit({ factory: () => ++serial, lifetime: "scoped" });
  const denied = failure(new Error("denied"));
  const access = guard<string>()({
    requirements: { session },
    run: (actor, ctx) => {
      checked.push(`${actor}:${ctx.session}`);
      return actor === "allowed" ? success() : denied;
    },
  });
  const first = expose({
    requirements: { session },
    guards: { access },

    run: (_input, ctx) => success(ctx.session),
  });
  const second = expose({
    requirements: { session },
    guards: { permission: access },

    run: (_input, ctx) => success(ctx.session),
  });
  assert.equal(first.guards.access, second.guards.permission);
  const definition = defineApplication({ modules: [provideFlow([expose.compose({ first, second })])] });
  const app = await runApplication(definition);
  const overridden = await runApplication(definition, {
    overrides: [override(access, () => Promise.resolve(success()))],
  });
  try {
    assert.deepEqual(await app.resolve(first)({ input: undefined, access: "allowed" }), 1);
    assert.deepEqual(await app.resolve(second)({ input: undefined, permission: "allowed" }), 2);
    await assert.rejects(
      app.resolve(second)({ input: undefined, permission: "denied" }),
      (error) => error === denied.error,
    );
    assert.deepEqual(checked, ["allowed:1", "allowed:2", "denied:3"]);
    assert.deepEqual(await overridden.resolve(first)({ input: undefined, access: "denied" }), 4);
    assert.deepEqual(await overridden.resolve(second)({ input: undefined, permission: "denied" }), 5);
    assert.equal(checked.length, 3);
  } finally {
    await Promise.all([app.stop(), overridden.stop()]);
  }
});
