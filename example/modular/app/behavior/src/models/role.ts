import { model, success } from "@openknot-ts/behavior";
import { z } from "zod";

export const roleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(64),
    active: z.boolean(),
  })
  .readonly();

export type RoleState = z.infer<typeof roleSchema>;

export const Role = model({
  invariants: roleSchema,
  mutations: {
    create: (input: RoleState) => success(input),
    rename: (role: RoleState, name: string) => success({ ...role, name }),
  },
});
