import { knotLock } from "./index.ts";
import { lock } from "@openknot-ts/lock/wire";
import { unit } from "@openknot-ts/wire";

export const inProcessLock = unit({ provides: lock, factory: () => knotLock() });
