import type { Tracing } from "./index.ts";
import { unit } from "@openknot-ts/wire";

/** Implementations provide it with ordinary Wire composition; instrumentation consumes `optional(trace)`. */
export const trace = unit.contract<Tracing>();
