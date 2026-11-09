import { isReaderComposition, reader } from "../src/index.ts";
import { plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("reader compositions snapshot members without changing independent reader identity", () => {
  const first = reader<() => string>();
  const second = reader<(id: number) => Promise<boolean>>();
  const members = { first, second };
  const group = reader.compose(members);
  Object.assign(members, { first: second });
  assert.equal(isReaderComposition(group), true);
  assert.deepEqual(group.members, { first, second });
  assert.equal(group.members.first, first);
  assert.ok(Object.isFrozen(group));
  assert.ok(Object.isFrozen(group.members));
  assert.equal(plug({ port: first, bind: () => () => "ok" }).port, first);
  assert.throws(() => reader.compose({ first, duplicate1: first }), /Duplicate/);
  assert.throws(() => reader.compose({}), /non-empty/);
  assert.throws(() => Reflect.apply(reader.compose, undefined, [[{}]]), /readers/);
});
