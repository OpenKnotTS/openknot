import { BehaviorBindingError, reader, standalone } from "../src/index.ts";
import { plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("standalone accepts only operations; bindings are already the functions to call", () => {
  const contract = reader<() => number>();
  const binding = plug({ port: contract, bind: () => () => 42 });
  for (const value of [undefined, null, contract, binding, {}, { implementation: () => 42 }]) {
    assert.throws(() => Reflect.apply(standalone, undefined, [value]), BehaviorBindingError.is);
  }
});
