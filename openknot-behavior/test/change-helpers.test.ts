import type { Event } from "../src/index.ts";
import { created, deleted, operation, standalone, success, unchanged, updated } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Changed extends Event {
  readonly type: "Changed";
}

test("change helpers keep state ownership with the caller and work through operation execution", async () => {
  const state = { id: "id", name: "Before" };
  const descriptors = [created(state), updated(state), deleted(state), unchanged(state)] as const;
  for (const descriptor of descriptors) {
    assert.ok(Object.isFrozen(descriptor));
  }
  assert.equal(Object.isFrozen(state), false);
  state.name = "After";
  const apply = operation<(typeof descriptors)[number]["changeType"], unknown, Changed>()({
    run: (kind) => {
      switch (kind) {
        case "created":
          return success({ output: descriptors[0], events: [{ type: "Changed" }] });
        case "updated":
          return success({ output: descriptors[1], events: [{ type: "Changed" }] });
        case "deleted":
          return success({ output: descriptors[2], events: [{ type: "Changed" }] });
        case "unchanged":
          return success({ output: descriptors[3], events: [] });
      }
    },
  });
  const run = standalone(apply);
  for (const descriptor of descriptors) {
    const result = await run(descriptor.changeType);
    assert.ok(!result.isError);
    const output = result.value.output;
    assert.equal(output.changeType, descriptor.changeType);
    const returnedState =
      output.changeType === "unchanged"
        ? output.current
        : output.changeType === "deleted"
          ? output.previous
          : output.next;
    assert.equal(returnedState, state);
    assert.equal(returnedState.name, "After");
    assert.equal(result.value.events.length, output.changeType === "unchanged" ? 0 : 1);
  }
});
