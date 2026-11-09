import type { Outcome, ModelValidationError } from "../src/index.ts";
import { error, failure, model, success } from "../src/index.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

function expectType<T>(_value: T): void {}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const Rejected = error("Rejected");
type Rejected = ReturnType<typeof Rejected>;

/** Compile-only schema input, parsed output and error inference contracts. */
export function verifySchemaModelTypes(): void {
  const standardOnly: StandardSchemaV1<number, string> = {
    "~standard": {
      version: 1,
      vendor: "standard-only-types",
      validate: (value) =>
        typeof value === "number" ? { value: String(value) } : { issues: [{ message: "Expected a number" }] },
    },
  };
  const Formatted = model({
    name: "formatted",
    invariants: standardOnly,
    mutations: { format: (value: number) => success(value) },
  });
  expectType<Outcome<string, ModelValidationError>>(Formatted.format(42));
  const incompatible = {
    name: "incompatible",
    invariants: standardOnly,
    mutations: { format: () => success("already formatted") },
  };
  // @ts-expect-error Standard Schema input types constrain the mutation's raw output
  model(incompatible);
  const schema = z.string().transform((value) => value.length);
  const Length = model({
    name: "length",
    invariants: schema,
    mutations: {
      measure: (value: string) => success(value),
      reject: () => failure(Rejected()),
    },
  });
  const measured = Length.measure("value");
  expectType<Outcome<number, ModelValidationError>>(measured);
  const exact: Equal<typeof measured, Outcome<number, ModelValidationError>> = true;
  expectType<true>(exact);
  const wrongState = { name: "bad", invariants: z.string(), mutations: { change: () => success("text") } };
  // @ts-expect-error schema models infer State; model<State>() is only for models without a schema
  model<number>()(wrongState);
  expectType<Outcome<number, Rejected | ModelValidationError>>(Length.reject());
  // @ts-expect-error the wrapped mutation preserves its input signature
  Length.measure(42);
  const invalid = {
    name: "invalid",
    invariants: schema,
    mutations: { measure: () => success(42) },
  };
  // @ts-expect-error mutation results must match the schema input, not its transformed output
  model(invalid);
  const Role = model({
    name: "role",
    invariants: z.object({ name: z.string() }).readonly(),
    mutations: { create: (name: string) => success({ name }) },
  });
  const result = Role.create("Role");
  if (!result.isError) {
    // @ts-expect-error the schema's readonly output is preserved
    result.value.name = "Changed";
  }
}
