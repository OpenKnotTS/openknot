import type { RoleEvent } from "../behavior/events.ts";
import type { LogState } from "../behavior/models/log.ts";
import type { RoleState } from "../behavior/models/role.ts";
import { createRoleOp, createLogFromRoleOp } from "../behavior/operations.ts";
import { saveRoleWriter, saveLogWriter, rolePublisher, logPublisher } from "./ports.ts";
import { success } from "@openknot-ts/behavior";
import { command } from "@openknot-ts/flow";

export const createRoleCommand = command<RoleState, RoleState>()({
  requirements: { createRoleOp, saveRoleWriter, rolePublisher },
  run: async (input, ctx) => {
    const result = await ctx.createRoleOp(input);

    if (result.isError) {
      return result;
    }

    const { output, events } = result.value;
    const saved = await ctx.saveRoleWriter(output.next);

    for (const event of events) {
      await ctx.rolePublisher.publish(event);
    }

    return success(saved.next);
  },
});

export const createLogFromRoleCommand = command<RoleEvent, LogState>()({
  requirements: { createLogFromRoleOp, saveLogWriter, logPublisher },
  run: async (input, ctx) => {
    const result = await ctx.createLogFromRoleOp(input);

    if (result.isError) {
      return result;
    }

    const { output, events } = result.value;
    const saved = await ctx.saveLogWriter(output.next);

    for (const event of events) {
      await ctx.logPublisher.publish(event);
    }

    return success(saved.next);
  },
});
