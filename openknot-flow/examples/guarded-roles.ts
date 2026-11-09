import { expose, guard } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { error, failure, reader, success } from "@openknot-ts/behavior";
import { plug, runApplication, defineApplication, composeModule, unit } from "@openknot-ts/wire";

interface Role {
  readonly id: string;
  readonly name: string;
}

const RoleAccessDenied = error("RoleAccessDenied");
type RoleAccessDenied = ReturnType<typeof RoleAccessDenied>;

// Contracts
const findRoleById = reader<(id: string) => Promise<Role | null>>();
const listRoles = reader<() => Promise<readonly Role[]>>();

const canReadRoles = guard<{ readonly permissions: readonly string[] }>()({
  run: (input) => (input.permissions.includes("roles:read") ? success() : failure(RoleAccessDenied())),
});

// Exposures
const getRole = expose<{ readonly roleId: string }>()({
  requirements: { findRoleById },
  guards: { canReadRoles },
  run: async (input, ctx) => success(await ctx.findRoleById(input.roleId)),
});

const getRoles = expose({
  requirements: { listRoles },
  guards: { canReadRoles },
  run: async (_input, ctx) => success(await ctx.listRoles()),
});

const getStatus = expose({
  run: () => success({ status: "ok" as const }),
});

const rolesApi = expose.compose({ getRole, getRoles, getStatus });

// Infrastructure decides how the reader contracts are implemented.
const database = unit({
  factory: () => new Map<string, Role>([["r1", { id: "r1", name: "Dispatcher" }]]),
});

const roleData = plug({
  port: reader.compose({ findRoleById, listRoles }),
  requirements: { database },
  bind: ({ database }) => ({
    findRoleById: (id) => Promise.resolve(database.get(id) ?? null),
    listRoles: () => Promise.resolve([...database.values()]),
  }),
});

const app = await runApplication(
  defineApplication({
    modules: [provideFlow([rolesApi]), composeModule({ providers: { roleData } })],
  }),
);

try {
  console.log(await app.resolve(getStatus)({ input: undefined }));

  // A transport plug supplies permissions from its authenticated session.
  const canReadRolesInput = { permissions: ["roles:read"] };
  console.log(await app.resolve(getRole)({ input: { roleId: "r1" }, canReadRoles: canReadRolesInput }));
  console.log(await app.resolve(getRoles)({ input: undefined, canReadRoles: canReadRolesInput }));

  // The invoker hands the guard's failure to its caller as an exception, as a transport receives it.
  await app
    .resolve(getRole)({ input: { roleId: "r1" }, canReadRoles: { permissions: [] } })
    .catch((error: unknown) => {
      console.log("denied", RoleAccessDenied.is(error));
    });
} finally {
  await app.stop();
}
