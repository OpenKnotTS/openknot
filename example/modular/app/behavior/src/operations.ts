import type { RoleEvent, LogEvent } from "./events.ts";
import { Log } from "./models/log.ts";
import type { LogState } from "./models/log.ts";
import { Role } from "./models/role.ts";
import type { RoleState } from "./models/role.ts";
import { created, operation, success } from "@openknot-ts/behavior";

export const createRoleOp = operation<RoleState, RoleState, RoleEvent>()({
  run: (input) => {
    const role = Role.create(input);

    if (role.isError) {
      return role;
    }

    return success({
      output: created(role.value),
      events: [{ type: "RoleChanged", role: role.value }],
    });
  },
});

export const createLogFromRoleOp = operation<RoleEvent, LogState, LogEvent>()({
  run: (event) => {
    const log = Log.createFromRole(event.role);

    if (log.isError) {
      return log;
    }

    return success({
      output: created(log.value),
      events: [{ type: "LogCreated", log: log.value }],
    });
  },
});
