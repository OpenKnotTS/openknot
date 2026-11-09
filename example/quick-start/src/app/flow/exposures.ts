import { createRoleCommand } from "./commands.ts";
import { userHasAccessToRoleGuard } from "./guards.ts";
import { getStateQuery } from "./queries.ts";
import { expose } from "@openknot-ts/flow";

export const createRoleExposure = expose({
  handler: createRoleCommand,
  guards: { userHasAccessToRoleGuard },
});

export const getStateExposure = expose({
  handler: getStateQuery,
  guards: { userHasAccessToRoleGuard },
});
