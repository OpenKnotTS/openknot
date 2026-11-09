import type { Event } from "../src/index.ts";
import { error, failure, model, operation, reader, success, unchanged, updated } from "../src/index.ts";
import { provideBehavior } from "../src/wire.ts";
import { runApplication, defineApplication, composeModule, plug } from "@openknot-ts/wire";

interface Role {
  readonly id: string;
  readonly name: string;
}

const RoleMissingError = error("RoleMissingError");
type RoleMissingError = ReturnType<typeof RoleMissingError>;

const Role = model<Role>()({
  name: "role",
  mutations: {
    rename: (role: Role, name: string) => success({ ...role, name }),
  },
});

const findRole = reader<(id: string) => Promise<Role | null>>();

type RoleEvent = Event & {
  readonly type: "RoleRenamed";
  readonly roleId: string;
};

const renameRole = operation<{ readonly id: string; readonly name: string }, Role, RoleEvent>()({
  requirements: { findRole },
  run: async (input, ctx) => {
    const role = await ctx.findRole(input.id);

    if (role === null) {
      return failure(RoleMissingError(input.id));
    }

    const renamed = Role.rename(role, input.name);

    if (renamed.isError) {
      return renamed;
    }

    if (renamed.value.name === role.name) {
      return success({ output: unchanged(role), events: [] });
    }

    return success({
      output: updated(renamed.value),
      events: [{ type: "RoleRenamed" as const, roleId: role.id }],
    });
  },
});

// Wiring: the behavior module requires the reader module that implements its reader.
const roleOperations = operation.compose({ renameRole });
const roles = provideBehavior([roleOperations]);

const readers = composeModule({
  providers: {
    findRole: plug({
      port: findRole,
      bind: () => (id) => Promise.resolve(id === "r1" ? { id, name: "Supervisor" } : null),
    }),
  },
});

const app = await runApplication(
  defineApplication({
    modules: readers.requiredBy(roles),
  }),
);

try {
  const renamed = await app.withScope((scope) => scope.resolve(renameRole)({ id: "r1", name: "Dispatcher" }));
  console.log(renamed);

  const unchangedResult = await app.withScope((scope) => scope.resolve(renameRole)({ id: "r1", name: "Supervisor" }));
  console.log(unchangedResult);
} finally {
  await app.stop();
}
