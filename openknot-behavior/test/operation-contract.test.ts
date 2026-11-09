import type { Event, OperationFactory } from "../src/index.ts";
import { InternalBehaviorError, operation, standalone, success } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Removed extends Event {
  readonly type: "Removed";
  readonly id: string;
}

test("event-free operations return fixed changes without an events field or mutation of author-owned output", async () => {
  const state = { id: "id", name: "Before" };
  const output = { changeType: "updated" as const, next: state };
  const update = operation({ run: () => success({ output }) });
  const result = await standalone(update)();
  assert.ok(!result.isError);
  assert.deepEqual(result.value, { output });
  assert.equal(Object.hasOwn(result.value, "events"), false);
  assert.ok(Object.isFrozen(result.value) && Object.isFrozen(result.value.output));
  assert.equal(Object.isFrozen(output), false);
  assert.equal(result.value.output.next, state);
  output.next = { id: "changed", name: "After" };
  assert.equal(result.value.output.next, state);
});

test("deletions preserve their previous state and declared empty event arrays remain present", async () => {
  const remove = operation<{ readonly id: string }, unknown, Removed>()({
    run: (state) =>
      success({ output: { changeType: "deleted", previous: state }, events: [{ type: "Removed", id: state.id }] }),
  });
  const state = { id: "id" };
  const removed = await standalone(remove)(state);
  assert.deepEqual(
    removed,
    success({ output: { changeType: "deleted", previous: state }, events: [{ type: "Removed", id: "id" }] }),
  );
  const quiet = operation<void, number, Removed>()({
    run: () => success({ output: { changeType: "updated", next: 1 }, events: [] }),
  });
  const result = await standalone(quiet)();
  assert.ok(!result.isError);
  assert.ok(Object.hasOwn(result.value, "events"));
  assert.deepEqual(result.value.events, []);
  assert.ok(Object.isFrozen(result.value.events));
});

test("untyped changes and malformed domain event envelopes fail inside the operation boundary", async () => {
  const sparseEvents: unknown[] = [];
  sparseEvents.length = 1;
  const invalid = [
    {},
    { output: null },
    { output: 1 },
    { output: [] },
    { output: { changeType: "custom", next: 1 } },
    { output: { changeType: "created" } },
    { output: { changeType: "updated", previous: 1 } },
    { output: { changeType: "deleted", next: 1 } },
    { output: { changeType: "deleted", previous: 1, next: 2 } },
    ...[undefined, null, {}, [null], [{}], [{ type: "" }], [{ type: 1 }], sparseEvents].map((events) => ({
      output: { changeType: "created", next: 1 },
      events,
    })),
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

test("structural change wrappers retain their states and read accessor values once", async () => {
  let changeReads = 0;
  let stateReads = 0;
  let eventReads = 0;
  const state = { id: "id" };
  // Accessors live on the prototype, so the wrapper must read them once rather than copy own properties.
  const change = Object.create({
    get changeType() {
      changeReads++;
      return "updated" as const;
    },
    get next() {
      stateReads++;
      return state;
    },
  }) as { readonly changeType: "updated"; readonly next: typeof state };
  const update = operation<void, { readonly id: string }, Removed>()({
    run: () =>
      success({
        output: change,
        get events() {
          eventReads++;
          return [{ type: "Removed" as const, id: state.id }];
        },
      }),
  });
  const result = await standalone(update)();
  assert.deepEqual(
    result,
    success({ output: { changeType: "updated", next: state }, events: [{ type: "Removed", id: "id" }] }),
  );
  assert.deepEqual([changeReads, stateReads, eventReads], [1, 1, 1]);
});
