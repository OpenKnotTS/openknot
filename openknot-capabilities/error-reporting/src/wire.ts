import type { ErrorReporter } from "./index.ts";
import { unit } from "@openknot-ts/wire";

/**
 * Implementations provide it with ordinary Wire composition, such as `provideSentry()`; Flow and plugs consume
 * `optional(errorReporter)` and report nothing until one is bound. Logging stays with the application's logger.
 */
export const errorReporter = unit.contract<ErrorReporter>();
