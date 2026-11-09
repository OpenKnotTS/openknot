import type { Versioning } from "./index.ts";
import { unit } from "@openknot-ts/wire";

/** Implementation plugs augment this interface with the targets they accept, such as their table types. */
export interface VersioningTargets {}
export type VersioningTarget = VersioningTargets[keyof VersioningTargets];

/** The application's versioning implementation; a plug provides it. */
export const versioning = unit.contract<Versioning<VersioningTarget>>();
