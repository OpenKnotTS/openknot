import { listRoles, listLogs } from "../behavior/readers.ts";
import { success } from "@openknot-ts/behavior";
import { query } from "@openknot-ts/flow";

export const getStateQuery = query({
  requirements: { listRoles, listLogs },
  run: async (_input, ctx) => {
    const roles = await ctx.listRoles();
    const logs = await ctx.listLogs();

    return success({ roles, logs });
  },
});
