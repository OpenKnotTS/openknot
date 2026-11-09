import type { Outcome } from "../src/index.ts";
import { failure, InternalBehaviorError, ModelValidationError, model, success } from "../src/index.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";

test("schema invariants parse every successful mutation once and return normalized immutable state", () => {
  let parses = 0;
  const schema = z
    .object({ name: z.string().trim().min(1) })
    .transform((state) => {
      parses++;
      return state;
    })
    .readonly();
  const Role = model({
    name: "role",
    invariants: schema,
    mutations: {
      create: (name: string) => success({ name, ignored: true }),
      rename: (role: z.output<typeof schema>, name: string) => success({ ...role, name }),
    },
  });
  const created = Role.create("  Original  ");
  assert.ok(!created.isError);
  assert.deepEqual(created.value, { name: "Original" });
  assert.ok(Object.isFrozen(created.value));
  const renamed = Role.rename(created.value, "  Renamed  ");
  assert.ok(!renamed.isError);
  assert.deepEqual(renamed.value, { name: "Renamed" });
  assert.ok(Object.isFrozen(renamed.value));
  assert.equal(created.value.name, "Original");
  assert.equal(parses, 2);
});

test("schema validation failures preserve standard issues in a ModelValidationError Outcome", () => {
  const schema = z.object({ name: z.string().min(1, "A name is required.") });
  const Role = model({
    name: "role",
    invariants: schema,
    mutations: { create: (name: string) => success({ name }) },
  });
  const rejected = Role.create("");
  assert.ok(rejected.isError && ModelValidationError.is(rejected.error));
  assert.deepEqual(
    rejected.error.issues.map(({ path, message }) => ({ path, message })),
    [{ path: ["name"], message: "A name is required." }],
  );
});

test("declared mutation failures pass through without parsing the schema", () => {
  let parses = 0;
  const schema = z.string().transform((value) => {
    parses++;
    return value.length;
  });
  const cause = new Error("Action rejected");
  const rejected = failure(cause);
  const Value = model({
    name: "value",
    invariants: schema,
    mutations: { reject: (): Outcome<string, Error> => rejected },
  });
  assert.equal(Value.reject(), rejected);
  assert.equal(parses, 0);
});

test("model mutations return the schema output when its type differs from its input", () => {
  const Length = model({
    name: "length",
    invariants: z.string().transform((value) => value.length),
    mutations: { measure: (value: string) => success(value) },
  });
  assert.deepEqual(Length.measure("word"), success(4));
});

test("unexpected schema exceptions stay inside the model mutation boundary", () => {
  const cause = new Error("Refinement defect");
  const schema: StandardSchemaV1<string> = {
    "~standard": {
      version: 1,
      vendor: "throwing-standard-test",
      validate() {
        throw cause;
      },
    },
  };
  const Value = model({
    name: "value",
    invariants: schema,
    mutations: { change: (value: string) => success(value) },
  });
  assert.throws(
    () => Value.change("input"),
    (error) => InternalBehaviorError.is(error) && error.cause === cause && error.boundary === "value.change",
  );
});

test("async schemas cannot turn synchronous model mutations into promises", () => {
  const Value = model({
    name: "value",
    invariants: z.string().refine(async () => true),
    mutations: { change: (value: string) => success(value) },
  });
  assert.throws(
    () => Value.change("input"),
    (error) => InternalBehaviorError.is(error) && error.boundary === "value.change",
  );
});

test("invalid schema declarations fail at model construction", () => {
  for (const invariants of [
    null,
    {},
    { safeParse() {} },
    { "~standard": { version: 2, vendor: "test", validate() {} } },
    { "~standard": undefined },
  ]) {
    assert.throws(
      () =>
        Reflect.apply(model<string>(), undefined, [
          {
            name: "invalid",
            invariants,
            mutations: { create: () => success("input") },
          },
        ]),
      /Model invariants must be a Standard Schema v1 schema or a function/,
    );
  }
});

test("model validation consumes a Standard Schema with no safeParse method", () => {
  const issues = [{ message: "Invalid value", path: [{ key: "input" }] }] as const;
  const schema: StandardSchemaV1<string, number> = {
    "~standard": {
      version: 1,
      vendor: "standard-only-test",
      validate(value) {
        return typeof value === "string" && value !== "invalid" ? { value: value.length } : { issues };
      },
    },
  };
  const Length = model({
    name: "length",
    invariants: schema,
    mutations: { measure: (value: string) => success(value) },
  });
  assert.equal("safeParse" in schema, false);
  assert.deepEqual(Length.measure("word"), success(4));
  assert.deepEqual(Length.measure(""), success(0));
  const result = Length.measure("invalid");
  assert.ok(result.isError && ModelValidationError.is(result.error));
  assert.deepEqual(result.error.issues, issues);
  assert.ok(Object.isFrozen(result.error.issues));
});

test("callable Standard Schemas use validate rather than the callback invariant path", () => {
  const schema: (() => never) & StandardSchemaV1<string, string> = Object.assign(
    () => {
      throw new Error("A callable schema must not run as an invariant callback.");
    },
    {
      "~standard": {
        version: 1 as const,
        vendor: "callable-standard-test",
        validate(value: unknown) {
          return typeof value === "string"
            ? { value: value.toUpperCase() }
            : { issues: [{ message: "Expected a string" }] };
        },
      },
    },
  );
  const Value = model({
    name: "value",
    invariants: schema,
    mutations: { change: (value: string) => success(value) },
  });
  assert.deepEqual(Value.change("input"), success("INPUT"));
});

test("async Standard Schema rejection is observed while models remain synchronous", async () => {
  const schema: StandardSchemaV1<string> = {
    "~standard": {
      version: 1,
      vendor: "async-standard-test",
      validate: () => Promise.reject(new Error("Async validation failed")),
    },
  };
  const Value = model({
    name: "value",
    invariants: schema,
    mutations: { change: (value: string) => success(value) },
  });
  assert.throws(
    () => Value.change("input"),
    (error) =>
      InternalBehaviorError.is(error) &&
      error.cause instanceof TypeError &&
      /schema validation must be synchronous/.test(error.cause.message),
  );
  await setImmediate();
});

test("a model name is optional and only labels its error boundary", () => {
  const cause = new Error("Mutation defect");
  const Value = model({
    invariants: z.string(),
    mutations: {
      change: (): Outcome<string, Error> => {
        throw cause;
      },
    },
  });
  assert.equal("name" in Value, false);
  assert.throws(
    () => Value.change(),
    (error) => InternalBehaviorError.is(error) && error.boundary === "change",
  );
  assert.throws(() => model({ name: "", invariants: z.string() }), /non-empty diagnostic name/);
});
