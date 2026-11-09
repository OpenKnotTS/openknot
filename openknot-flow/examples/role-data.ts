import { listener, writer } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import type { Event } from "@openknot-ts/behavior";
import { reader, success } from "@openknot-ts/behavior";
import { plug, runApplication, defineApplication, composeModule, unit } from "@openknot-ts/wire";

interface Role {
  readonly id: string;
  readonly name: string;
}

type RoleEvent = Event & { readonly type: "RoleRenamed"; readonly id: string; readonly name: string };

// Contracts
const findRoleById = reader<(id: string) => Promise<Role | null>>();
const isRoleNameTaken = reader<(name: string) => Promise<boolean>>();
const saveRole = writer<(role: Role) => Promise<void>>();
const roleReaders = reader.compose({ findRoleById, isRoleNameTaken });

// Infrastructure for the example; a real provider can expose a database or remote API.
const database = unit({
  factory: () => {
    const roles = new Map<string, Role>([["r1", { id: "r1", name: "Supervisor" }]]);

    return {
      roles: {
        findById: (id: string) => Promise.resolve(roles.get(id) ?? null),
        isNameTaken: (name: string) => Promise.resolve([...roles.values()].some((role) => role.name === name)),
        save: (role: Role) => {
          roles.set(role.id, role);
          return Promise.resolve();
        },
      },
    };
  },
});

const databaseRoleReaders = plug({
  port: roleReaders,
  requirements: { database },
  bind: ({ database }) => ({
    findRoleById: (id) => database.roles.findById(id),
    isRoleNameTaken: (name) => database.roles.isNameTaken(name),
  }),
});

const databaseRoleWriter = plug({
  port: saveRole,
  requirements: { database },
  bind:
    ({ database }) =>
    (role) =>
      database.roles.save(role),
});

// A listener that reads and writes through the contracts
const onRoleRenamed = listener<RoleEvent>()({
  requirements: { findRoleById, saveRole },
  run: async (input, ctx) => {
    const role = await ctx.findRoleById(input.id);

    if (role === null) {
      return success(null);
    }

    const next = { ...role, name: input.name };
    await ctx.saveRole(next);

    return success(next);
  },
});

const app = await runApplication(
  defineApplication({
    modules: [
      provideFlow([onRoleRenamed, roleReaders, saveRole]),
      composeModule({ providers: { databaseRoleReaders, databaseRoleWriter } }),
    ],
  }),
);

try {
  console.log(await app.resolve(onRoleRenamed)({ input: { type: "RoleRenamed", id: "r1", name: "Dispatcher" } }));
  await app.withScope(async (scope) => console.log(await scope.resolve(findRoleById)("r1")));
} finally {
  await app.stop();
}
