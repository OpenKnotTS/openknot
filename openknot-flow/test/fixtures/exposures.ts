import { expose, guard } from "../../src/index.ts";
import { success } from "@openknot-ts/behavior";

const access = guard({ requirements: {}, run: () => success() });
export const fixtureExposure = expose<string>()({
  requirements: {},
  guards: { access },
  run: (input) => success(input),
});
