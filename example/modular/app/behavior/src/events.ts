import type { LogState } from "./models/log.ts";
import type { RoleState } from "./models/role.ts";

export type RoleEvent = {
  readonly type: "RoleChanged";
  readonly role: RoleState;
};

export type LogEvent = {
  readonly type: "LogCreated";
  readonly log: LogState;
};
