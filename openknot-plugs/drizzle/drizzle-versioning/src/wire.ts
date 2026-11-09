import type { VersionedTable } from "./index.ts";
import type {} from "@openknot-ts/versioning/wire";

declare module "@openknot-ts/versioning/wire" {
  interface VersioningTargets {
    readonly drizzle: VersionedTable;
  }
}
