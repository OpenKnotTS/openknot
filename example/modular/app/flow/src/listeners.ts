export type { AppActor } from "./actor.ts";
import { createLogFromRoleCommand } from "./commands.ts";
import { listener } from "@openknot-ts/flow";

export const roleChangedListener = listener({ handler: createLogFromRoleCommand });
