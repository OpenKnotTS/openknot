import { AccessDenied, userHasAccessToRole } from "./ports.ts";
import { failure, success } from "@openknot-ts/behavior";
import { guard } from "@openknot-ts/flow";

export const userHasAccessToRoleGuard = guard({
  requirements: { userHasAccessToRole },
  run: async (_, ctx) => {
    const allowed = await ctx.userHasAccessToRole(ctx.actor?.userId);

    return allowed ? success() : failure(AccessDenied("The actor is not allowed to access roles."));
  },
});
