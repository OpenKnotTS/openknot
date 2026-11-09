import type { Lock } from "./index.ts";
import { unit } from "@openknot-ts/wire";

/** The application's lock implementation; a plug provides it. */
export const lock = unit.contract<Lock>();
