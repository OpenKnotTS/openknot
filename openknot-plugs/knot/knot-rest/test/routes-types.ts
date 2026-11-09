import { restRoutes } from "../src/index.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import { command, expose, guard, query } from "@openknot-ts/flow";
import { z } from "zod";

const RoleNameTaken = error("RoleNameTaken", (role: string) => ({ message: `Role ${role} exists`, role }));
const AccessDenied = error("AccessDenied");
const access = guard<string>()({ run: (token) => (token === "allow" ? success() : failure(AccessDenied())) });
const createRole = expose({
  handler: command<{ readonly name: string }, { readonly id: string }>()({
    run: (input) => (input.name === "" ? failure(RoleNameTaken(input.name)) : success({ id: "r1" })),
  }),
  guards: { access },
});
const getState = expose({ handler: query({ run: () => success(1) }) });
const port = expose.compose({ createRole, getState });
const input = z.object({ name: z.string() });
const guards = () => ({ access: "allow" });

restRoutes({
  port,
  errors: { AccessDenied: 403 },
  routes: {
    createRole: {
      post: "/roles",
      input,
      guards,
      errors: {
        RoleNameTaken: (taken) => {
          const role: string = taken.role;
          // @ts-expect-error The handler is narrowed to its own error type.
          void taken.issues;
          return { status: 409, body: { role } };
        },
      },
    },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  routes: {
    // @ts-expect-error Every authored error needs a status in the route or the router.
    createRole: { post: "/roles", input, guards, errors: { RoleNameTaken: 409 } },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403 },
  routes: {
    // @ts-expect-error Unknown error types are rejected.
    createRole: { post: "/roles", input, guards, errors: { RoleNameTaken: 409, Missing: 404 } },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  // @ts-expect-error The router maps only errors its exposures can produce.
  errors: { Missing: 404 },
  routes: {
    createRole: { post: "/roles", input, guards, errors: { RoleNameTaken: 409, AccessDenied: 403 } },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  routes: {
    // @ts-expect-error An exposure with input needs an input schema.
    createRole: { post: "/roles", guards },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  routes: {
    // @ts-expect-error The schema's output must be the exposure's input.
    createRole: { post: "/roles", input: z.object({ title: z.string() }), guards },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  routes: {
    // @ts-expect-error Guards with data inputs need their mapping.
    createRole: { post: "/roles", input },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  routes: {
    // @ts-expect-error The mapping supplies each guard's own input type.
    createRole: { post: "/roles", input, guards: () => ({ access: 1 }) },
    getState: { get: "/state" },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  routes: {
    createRole: { post: "/roles", input, guards },
    // @ts-expect-error A route has exactly one method.
    getState: { get: "/state", post: "/state" },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  routes: {
    createRole: { post: "/roles", input, guards },
    // @ts-expect-error An exposure without input takes no input schema.
    getState: { get: "/state", input },
  },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  // @ts-expect-error Every member of the composition needs a route.
  routes: { createRole: { post: "/roles", input, guards } },
});

restRoutes({
  port,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  routes: {
    createRole: { post: "/roles", input, guards },
    getState: { get: "/state" },
    // @ts-expect-error Routes name only members of the composition.
    other: { get: "/other" },
  },
});

restRoutes({
  port: createRole,
  errors: { AccessDenied: 403 },
  routes: {
    post: "/roles",
    input,
    guards,
    errors: { RoleNameTaken: (taken) => ({ status: 409, body: { role: taken.role } }) },
  },
});

restRoutes({
  port: createRole,
  errors: { AccessDenied: 403, RoleNameTaken: 409 },
  // @ts-expect-error One exposure's route is checked like a member's: its input schema is required.
  routes: { post: "/roles", guards },
});

restRoutes({
  port: getState,
  // @ts-expect-error One exposure takes its route directly, not keyed by name.
  routes: { getState: { get: "/state" } },
});
