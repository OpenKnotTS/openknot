import { restBunHttp } from "../src/index.ts";
import { error, failure, reader, success } from "@openknot-ts/behavior";
import type { Upserted } from "@openknot-ts/flow";
import { command, expose, query, upserted, writer } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { http, httpServer } from "@openknot-ts/knot-http-bun";
import { restRoutes } from "@openknot-ts/knot-rest";
import { defineApplication, plug, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { z } from "zod";

// Contracts and errors
const roleSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
});

type Role = z.output<typeof roleSchema>;

const RoleExists = error("RoleExists", (id: string) => ({ message: `Role ${id} exists`, id }));
const RoleNotFound = error("RoleNotFound", (id: string) => ({ message: `Role ${id} not found`, id }));

const findRole = reader<(id: string) => Promise<Role | undefined>>();
const saveRole = writer<(role: Role) => Promise<Upserted<Role>>>();

// Exposures
const createRole = expose({
  handler: command<Role, Role>()({
    requirements: { findRole, saveRole },
    run: async (role, ctx) => {
      if ((await ctx.findRole(role.id)) !== undefined) {
        return failure(RoleExists(role.id));
      }

      const saved = await ctx.saveRole(role);
      return success(saved.next);
    },
  }),
});

const getRole = expose({
  handler: query<{ readonly id: string }, Role>()({
    requirements: { findRole },
    run: async ({ id }, ctx) => {
      const role = await ctx.findRole(id);
      return role === undefined ? failure(RoleNotFound(id)) : success(role);
    },
  }),
});

// Routes: one per exposure, with its input schema, status and error mapping
const roleRoutes = restRoutes({
  port: expose.compose({ createRole, getRole }),
  routes: {
    createRole: { post: "/roles", input: roleSchema, status: 201, errors: { RoleExists: 409 } },
    getRole: { get: "/roles/:id", input: z.object({ id: z.string() }), errors: { RoleNotFound: 404 } },
  },
});

// In-memory storage
const roles = unit({ factory: () => new Map<string, Role>() });

const memory = {
  readers: plug({
    port: findRole,
    requirements: { roles },
    bind:
      ({ roles }) =>
      async (id) =>
        roles.get(id),
  }),

  writers: plug({
    port: saveRole,
    requirements: { roles },
    bind:
      ({ roles }) =>
      async (role) => {
        roles.set(role.id, role);
        return upserted(role);
      },
  }),
};

const app = await runApplication(
  defineApplication({
    modules: [http, restBunHttp, provideFlow([createRole, getRole]), providePlugs([memory, roleRoutes])],
  }),
);

const url = app.resolve(httpServer).url;

console.log(`REST routes on ${url}`);
console.log(
  `curl -X POST ${new URL("/roles", url)} -H 'content-type: application/json' -d '{"id":"r1","name":"Admin"}'`,
);
console.log(`curl ${new URL("/roles/r1", url)}`);

await app.stopped;
