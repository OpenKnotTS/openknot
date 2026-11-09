import { operation, reader, standalone, success } from "../src/index.ts";
import { plug } from "@openknot-ts/wire";

const identity = reader<<const Value>(value: Value) => Value>();
// @ts-expect-error A reader definition is not an operation.
standalone(identity);
const binding = plug({
  port: identity,
  bind:
    () =>
    <const Value>(value: Value) =>
      value,
});
// @ts-expect-error A plug is not an operation.
standalone(binding);

const add = operation<number>()({
  run: (input) => success({ output: { changeType: "updated" as const, next: input + 1 } }),
});
const run = standalone(add);
void run(1);
// @ts-expect-error Standalone operations preserve their input type.
void run("wrong");
