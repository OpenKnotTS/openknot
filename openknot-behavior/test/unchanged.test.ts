import type { Event, OperationFactory } from "../src/index.ts";
import { InternalBehaviorError, operation, standalone, success } from "../src/index.ts";
import { composeModule, defineApplication, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/wire.ts";

interface Changed extends Event {
  readonly type: "Changed";
}

test("operations preserve explicit unchanged outcomes without comparing or mutating states", async () => {
  const state = Object.freeze({ id: "id" });
  const decide = operation<boolean>()({
    run: (changed) =>
      success({
        output: changed ? { changeType: "updated", next: state } : { changeType: "unchanged", current: state },
      }),
  });
  const run = standalone(decide);
  const unchanged = await run(false);
  assert.ok(!unchanged.isError && unchanged.value.output.changeType === "unchanged");
  assert.equal(unchanged.value.output.current, state);
  assert.equal(Object.hasOwn(unchanged.value, "events"), false);
  assert.equal(Object.hasOwn(unchanged.value.output, "next"), false);
  assert.ok(Object.isFrozen(unchanged.value) && Object.isFrozen(unchanged.value.output));
  const updated = await run(true);
  assert.ok(!updated.isError && updated.value.output.changeType === "updated");
  assert.equal(updated.value.output.next, state, "State identity does not decide whether a command changed anything.");
});

test("unchanged child results retain empty declared events through standalone and scoped DI", async () => {
  const child = operation<{ readonly id: string }, unknown, Changed>()({
    run: (current) => success({ output: { changeType: "unchanged", current }, events: [] }),
  });
  const parent = operation<{ readonly id: string }, unknown, Changed>()({
    requirements: { child },
    run: (input, ctx) => ctx.child(input),
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { parent } })] }));
  const state = { id: "id" };
  try {
    const results = [await standalone(parent)(state), await app.withScope((scope) => scope.resolve(parent)(state))];
    for (const result of results) {
      assert.ok(!result.isError);
      assert.deepEqual(result.value, { output: { changeType: "unchanged", current: state }, events: [] });
      assert.equal(result.value.output.current, state);
      assert.ok(Object.isFrozen(result.value.events));
    }
  } finally {
    await app.stop();
  }
});

test("untyped unchanged results cannot omit current, contain another state field or emit events", async () => {
  const invalid = [
    { output: { changeType: "unchanged" } },
    { output: { changeType: "unchanged", next: 1 } },
    { output: { changeType: "unchanged", current: 1, next: 1 } },
    { output: { changeType: "unchanged", current: 1, previous: 1 } },
    { output: { changeType: "updated", next: 1, current: 1 } },
    { output: { changeType: "deleted", previous: 1, current: 1 } },
    { output: { changeType: "unchanged", current: 1 }, events: [{ type: "Changed" }] },
  ];
  for (const draft of invalid) {
    const unsafe = Reflect.apply(operation(), undefined, [{ run: () => success(draft) }]) as ReturnType<
      OperationFactory<void>
    >;
    await assert.rejects(
      standalone(unsafe)(),
      (error) => InternalBehaviorError.is(error) && error.cause instanceof TypeError,
      JSON.stringify(draft),
    );
  }
});
