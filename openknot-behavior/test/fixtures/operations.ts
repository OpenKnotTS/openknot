import { operation, success } from "../../src/index.ts";
import { fixtureReader } from "./contracts.ts";

export const readFixture = operation({
  requirements: { fixtureReader },
  run: (_input, ctx) => success({ output: { changeType: "updated" as const, next: ctx.fixtureReader() } }),
});
