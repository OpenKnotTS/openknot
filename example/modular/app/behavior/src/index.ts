import { createRoleOp, createLogFromRoleOp } from "./operations.ts";
import { provideBehavior } from "@openknot-ts/behavior/wire";

export const behavior = provideBehavior([createRoleOp, createLogFromRoleOp]);
