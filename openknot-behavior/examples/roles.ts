import type { Event } from "../src/index.ts";
import { error, standalone, failure, model, operation, reader, success, unchanged, updated } from "../src/index.ts";
import { override } from "@openknot-ts/wire";
import { z } from "zod";

// State and errors
export const roleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1, "A role requires a name"),
    status: z.enum(["active", "inactive"]),
  })
  .readonly();

type RoleState = z.infer<typeof roleSchema>;

const RoleNotFoundError = error("RoleNotFound");
type RoleNotFoundError = ReturnType<typeof RoleNotFoundError>;

const RoleNameTakenError = error("RoleNameTaken");
type RoleNameTakenError = ReturnType<typeof RoleNameTakenError>;

// Readers: one independent function per read.
export const findRoleByIdReader = reader<(id: string) => Promise<RoleState | null>>();
export const isRoleNameTakenReader = reader<(name: string) => Promise<boolean>>();

// Model
export const Role = model({
  name: "role",
  invariants: roleSchema,
  mutations: {
    rename: (role: RoleState, name: string) => success({ ...role, name }),
    deactivate: (role: RoleState) => success({ ...role, status: "inactive" as const }),
  },
});

// Operation
type RoleEvent = Event & {
  readonly type: "RoleRenamed";
  readonly roleId: string;
  readonly name: string;
};

export const renameRole = operation<{ readonly roleId: string; readonly name: string }, RoleState, RoleEvent>()({
  tag: "role",
  requirements: { findRoleByIdReader, isRoleNameTakenReader },
  run: async (input, ctx) => {
    const role = await ctx.findRoleByIdReader(input.roleId);

    if (role === null) {
      return failure(RoleNotFoundError(input.roleId));
    }

    const renamed = Role.rename(role, input.name);

    if (renamed.isError) {
      return renamed;
    }

    if (renamed.value.name === role.name) {
      return success({ output: unchanged(role), events: [] });
    }

    if (await ctx.isRoleNameTakenReader(renamed.value.name)) {
      return failure(RoleNameTakenError(renamed.value.name));
    }

    return success({
      output: updated(renamed.value),
      events: [{ type: "RoleRenamed" as const, roleId: role.id, name: renamed.value.name }],
    });
  },
});

// Running it standalone: the caller supplies the readers. The behavior writes nothing and publishes nothing.
const storedRoles = new Map<string, RoleState>([["r1", { id: "r1", name: "Supervisor", status: "active" }]]);

const runRenameRole = standalone(renameRole, [
  override(findRoleByIdReader, (id) => Promise.resolve(storedRoles.get(id) ?? null)),
  override(isRoleNameTakenReader, (name) =>
    Promise.resolve([...storedRoles.values()].some((role) => role.name === name)),
  ),
]);

const result = await runRenameRole({ roleId: "r1", name: "Dispatcher" });
console.dir(result, { depth: null });

const unchangedResult = await runRenameRole({ roleId: "r1", name: "  Supervisor  " });
console.dir(unchangedResult, { depth: null });

// Persistence remains the responsibility of the caller or flow.
if (storedRoles.get("r1")?.name !== "Supervisor") {
  throw new Error("The behavior unexpectedly persisted a change");
}
