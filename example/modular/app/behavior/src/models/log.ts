import type { RoleState } from "./role.ts";
import { model, success } from "@openknot-ts/behavior";
import { z } from "zod";

export const logSchema = z
  .object({
    id: z.string().min(1),
    action: z.string().min(1),
  })
  .readonly();

export type LogState = z.infer<typeof logSchema>;

export const Log = model({
  invariants: logSchema,
  mutations: {
    createFromRole: (role: RoleState) =>
      success({
        id: role.id,
        action: `Created role "${role.name}"`,
      }),
  },
});
