import { failure, InternalBehaviorError, model, operation, standalone, success } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { z } from "zod";

interface State {
  readonly name: string;
  readonly count: number;
}

test("model queries expose raw values and arbitrary inputs without running state invariants", () => {
  let checks = 0;
  const schema = z.object({ name: z.string(), count: z.number() }).transform((state) => {
    checks++;
    return Object.freeze(state);
  });
  const rejected = failure(new Error("Expected query failure"));
  const original: State = Object.freeze({ name: "Before", count: 2 });
  const Model = model({
    name: "example",
    invariants: schema,
    mutations: { rename: (state: State, name: string) => success({ ...state, name }) },
    queries: {
      displayName: (state: State) => state.name,
      isNameValid: (name: string) => name.length > 0,
      times: (state: State, factor: number) => state.count * factor,
      nothing: () => undefined,
      reject: () => rejected,
    },
  });
  assert.equal(Model.displayName(original), "Before");
  assert.equal(Model.isNameValid(""), false);
  assert.equal(Model.times(original, 0), 0);
  assert.equal(Model.nothing(), undefined);
  assert.equal(Model.reject(), rejected);
  assert.equal(checks, 0);
  const renamed = Model.rename(original, "After");
  assert.ok(!renamed.isError);
  assert.deepEqual(renamed.value, { name: "After", count: 2 });
  assert.equal(checks, 1);
  assert.equal(original.name, "Before");
  assert.ok(Object.isFrozen(Model));
  assert.equal(Object.hasOwn(Model, "mutations"), false);
  assert.equal(Object.hasOwn(Model, "queries"), false);
});

test("query-only models snapshot functions and retain ordinary thrown errors", async () => {
  const cause = new Error("Query defect");
  const options = {
    name: "query-only",
    queries: {
      text: (state: State) => state.name,
      crash: (): string => {
        throw cause;
      },
    },
  };
  const Model = model<State>()(options);
  options.queries.text = () => "Changed";
  assert.equal(Model.text({ name: "Original", count: 1 }), "Original");
  assert.throws(
    () => Model.crash(),
    (error) => error === cause,
  );
  const run = standalone(
    operation({
      tag: "query-boundary",
      run: () => success({ output: { changeType: "updated" as const, next: Model.crash() } }),
    }),
  );
  await assert.rejects(
    run(),
    (error) => InternalBehaviorError.is(error) && error.cause === cause && error.boundary === "query-boundary",
  );
});

test("model definitions reject metadata collisions, duplicate methods and malformed function maps", () => {
  const define = model<number>();
  for (const options of [
    { name: "bad", mutations: { change: () => success(1) }, queries: { change: () => true } },
    { name: "bad", queries: { name: () => "bad" } },
    { name: "bad", mutations: null },
    { name: "bad", queries: [] },
    { name: "bad", queries: { value: 1 } },
  ]) {
    assert.throws(
      () => Reflect.apply(define, undefined, [options]),
      /distinct|diagnostic name|named object|Invalid model query/,
    );
  }
});

test("queries reject asynchronous results and observe promise and thenable rejections", async () => {
  for (const query of [
    () => Promise.reject(new Error("Async query")),
    (): unknown => runInNewContext('Promise.reject(new Error("Thenable query"))'),
  ]) {
    const Model = Reflect.apply(model<number>(), undefined, [{ name: "async", queries: { value: query } }]) as {
      value(): unknown;
    };
    assert.throws(() => Model.value(), /Model queries must be synchronous/);
  }
  const data: unknown = JSON.parse('{"then":"ordinary data"}');
  const Model = model<number>()({ name: "data", queries: { value: () => data } });
  assert.equal(Model.value(), data);
  await setImmediate();
});
