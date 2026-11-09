import type { LogState } from "./models/log.ts";
import type { RoleState } from "./models/role.ts";
import { reader } from "@openknot-ts/behavior";

export const listRoles = reader<() => Promise<readonly RoleState[]>>();
export const listLogs = reader<() => Promise<readonly LogState[]>>();
