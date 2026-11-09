import * as umbrellaBehavior from "../src/behavior/index.ts";
import * as umbrellaBehaviorWire from "../src/behavior/wire.ts";
import * as umbrellaFlow from "../src/flow/index.ts";
import * as umbrellaFlowWire from "../src/flow/wire.ts";
import * as umbrella from "../src/index.ts";
import * as behavior from "@openknot-ts/behavior";
import * as behaviorWire from "@openknot-ts/behavior/wire";
import * as flow from "@openknot-ts/flow";
import * as flowWire from "@openknot-ts/flow/wire";
import * as wire from "@openknot-ts/wire";
import assert from "node:assert/strict";
import test from "node:test";

// Identity matters: definitions, markers and contracts from either import path must be the same objects.
test("every entry re-exports the same values as the package it bundles", () => {
  for (const [bundled, original] of [
    [umbrella, wire],
    [umbrellaBehavior, behavior],
    [umbrellaBehaviorWire, behaviorWire],
    [umbrellaFlow, flow],
    [umbrellaFlowWire, flowWire],
  ] as const) {
    assert.deepEqual(Object.keys(bundled).sort(), Object.keys(original).sort());

    for (const key of Object.keys(original)) {
      assert.equal((bundled as Record<string, unknown>)[key], (original as Record<string, unknown>)[key], key);
    }
  }
});

test("an application composed only from the bundled entries runs", async () => {
  const greeting = umbrella.unit({ factory: () => "hello" });
  const app = await umbrella.runApplication(
    umbrella.defineApplication({ modules: [umbrella.composeModule({ providers: { greeting } })] }),
    { stopOn: [] },
  );

  try {
    assert.equal(app.resolve(greeting), "hello");
  } finally {
    await app.stop();
  }
});
