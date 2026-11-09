import { isList, itemsOf, managedIdentity, versionOf } from "../src/internal/managed.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("managed helpers", () => {
  it("does not accept an inherited entity or getter id", () => {
    const proto = { entity: "role", id: 1 };
    const value = Object.create(proto);
    assert.equal(managedIdentity(value), undefined);

    const obj = { entity: "role" };
    Object.defineProperty(obj, "id", { get: () => 1 });
    assert.equal(managedIdentity(obj), undefined);
  });

  it("does not accept NaN ids", () => {
    assert.equal(managedIdentity({ entity: "role", id: NaN }), undefined);
  });

  it("itemsOf unwraps arrays, items objects, null and undefined", () => {
    assert.deepEqual(itemsOf([1, 2]), [1, 2]);
    assert.deepEqual(itemsOf({ items: [3, 4] }), [3, 4]);
    assert.deepEqual(itemsOf(undefined), []);
    assert.deepEqual(itemsOf(null), []);
    assert.deepEqual(itemsOf(5), [5]);
  });

  const items = [{ entity: "role", id: "r1" }];
  const inherited: unknown = Object.create({ items });
  for (const { name, value } of [
    { name: "inherited", value: inherited },
    {
      name: "accessor-backed",
      value: {
        get items() {
          return items;
        },
      },
    },
  ]) {
    it(`isList recognizes ${name} items arrays`, () => {
      assert.equal(isList(value), true);
    });

    it(`itemsOf returns the original ${name} items array`, () => {
      assert.equal(itemsOf(value), items);
    });
  }

  it("versionOf rejects bigint versions", () => {
    assert.equal(versionOf({ version: 1n }), undefined);
  });
});
