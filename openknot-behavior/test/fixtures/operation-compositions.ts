import { operation, success } from "../../src/index.ts";
import { readFixture } from "./operations.ts";

const echo = operation<string>()({
  requirements: {},
  run: (text) => success({ output: { changeType: "updated" as const, next: text } }),
});
export const fixtureOperations = operation.compose({ readFixture, echo });
