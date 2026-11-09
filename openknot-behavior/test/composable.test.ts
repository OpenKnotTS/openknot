import { operation, reader, success } from "../src/index.ts";
import { composable } from "../src/internal/composable.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("composable preserves the original factory and keeps each composition's configuration", () => {
  const marker = Symbol("boxes");
  function createBox<const Value>(value: Value) {
    return Object.freeze({ kind: "box" as const, value });
  }
  const options = {
    name: "box",
    memberName: "box",
    marker,
    kind: "boxes" as const,
    isMember: (value: unknown): value is { readonly kind: "box"; readonly value: unknown } =>
      typeof value === "object" && value !== null && "kind" in value && value.kind === "box",
  };
  const box = composable(createBox, options);
  assert.equal(box, createBox);
  const first = box("one");
  options.marker = Symbol("changed");
  options.name = "changed";
  options.isMember = (_value): _value is { readonly kind: "box"; readonly value: unknown } => false;
  const group = box.compose({ first, second: box(2) });
  const literal: "one" = group.members.first.value;
  assert.equal(literal, "one");
  assert.equal(group[marker], true);
  assert.equal(group.members.first, first);
  assert.ok(Object.isFrozen(group) && Object.isFrozen(group.members));
  assert.throws(() => box.compose({ first, duplicate: first }), /Duplicate box in box.compose/);
});

test("primitive compositions reject sparse arrays and remain isolated by kind", () => {
  const read = reader<() => number>();
  const run = operation({
    requirements: {},
    run: () => success({ output: { changeType: "updated" as const, next: 1 } }),
  });
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[0] = read;
  assert.throws(() => Reflect.apply(reader.compose, undefined, [sparse]), /named object of readers/);
  sparse[0] = run;
  assert.throws(() => Reflect.apply(operation.compose, undefined, [sparse]), /named object of operations/);
  assert.throws(() => Reflect.apply(reader.compose, undefined, [[run]]), /named object of readers/);
  assert.throws(() => Reflect.apply(operation.compose, undefined, [[read]]), /named object of operations/);
  assert.equal(reader.compose({ read }).kind, "reader-composition");
  assert.equal(operation.compose({ run }).kind, "operation-composition");
});
