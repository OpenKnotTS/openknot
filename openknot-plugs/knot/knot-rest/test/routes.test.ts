import type { RestRequest } from "../src/index.ts";
import { readJsonBody, RestBodyError, restHeaders, restRouter, restRoutes } from "../src/index.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import { command, expose, guard, query, writer } from "@openknot-ts/flow";
import { actorResolver } from "@openknot-ts/flow/wire";
import type { TraceSpan, Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { VersionConflict } from "@openknot-ts/versioning";
import type { Definition } from "@openknot-ts/wire";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

const RoleNameTaken = error("RoleNameTaken", (role: string) => ({ message: `Role ${role} exists`, role }));
const AccessDenied = error("AccessDenied");
const access = guard<string | undefined>()({
  run: (token) => (token === "allow" ? success() : failure(AccessDenied())),
});
const saveRole = writer<(role: { readonly id: string; readonly name: string }) => Promise<void>>();

const createRole = expose({
  handler: command<
    { readonly name: string },
    { readonly id: string; readonly name: string; readonly actor: unknown }
  >()({
    run: (input, ctx) => {
      if (input.name === "taken") {
        return failure(RoleNameTaken(input.name));
      }
      if (input.name === "explode") {
        throw new Error("database password in a message");
      }
      return success({ id: "r1", name: input.name, actor: ctx.actor });
    },
  }),
  guards: { access },
});
const getRole = expose({
  handler: query<{ readonly id: string; readonly verbose?: string | undefined }, { readonly id: string }>()({
    run: (input) => success({ id: input.id, verbose: input.verbose }),
  }),
});
const newRole = expose({ handler: query({ run: () => success("new") }) });
const removeRole = expose({ handler: command<{ readonly id: string }>()({ run: () => success() }) });
const renameRole = expose({
  handler: command<{ readonly id: string; readonly name: string }>()({
    requirements: { saveRole },
    run: async (input, ctx) => {
      await ctx.saveRole(input);
      return success();
    },
  }),
});

const roleRoutes = restRoutes({
  port: expose.compose({ createRole, getRole, newRole, removeRole, renameRole }),
  errors: { AccessDenied: 403 },
  routes: {
    createRole: {
      post: "/roles",
      input: z.object({ name: z.string().min(1) }),
      status: 201,
      authenticate: true,
      guards: (request) => ({ access: request.headers.get("x-access") ?? undefined }),
      errors: { RoleNameTaken: (failed) => ({ status: 409, body: { taken: failed.role } }) },
    },
    getRole: {
      get: "/roles/:id",
      input: z.object({ id: z.string(), verbose: z.string().optional() }),
      output: z.object({ id: z.string() }),
    },
    newRole: { get: "/roles/new" },
    removeRole: { delete: "/roles/:id", input: z.object({ id: z.string() }) },
    renameRole: { put: "/roles/:id", input: z.object({ id: z.string(), name: z.string() }) },
  },
});

const identity = actorResolver({ resolve: (token) => (token === "good" ? { userId: "u1" } : undefined) });
const spans: TraceSpan[] = [];
const tracing: Tracing = {
  propagationFields: ["traceparent"],
  run: (span, work) => {
    spans.push(span);
    return work();
  },
  capture: () => undefined,
  bind: (work) => work,
};

function start(providers: readonly Definition[] = []) {
  return runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [
            createRole,
            getRole,
            newRole,
            removeRole,
            renameRole,
            roleRoutes,
            restRouter,
            identity,
            unit({ provides: trace, factory: () => tracing }),
            plug({
              port: saveRole,
              bind: () => (role) => Promise.reject(VersionConflict("roles", role.id, 1)),
            }),
            ...providers,
          ].map((source) => ({ source })),
        }),
      ],
    }),
  );
}

function request(
  method: string,
  url: string,
  options: { readonly body?: unknown; readonly headers?: Record<string, string>; readonly signal?: AbortSignal } = {},
): RestRequest {
  const parsed = new URL(url, "http://localhost");
  return {
    method,
    path: parsed.pathname,
    query: parsed.searchParams,
    headers: new Headers(options.headers),
    readBody: () => (options.body instanceof Error ? Promise.reject(options.body) : Promise.resolve(options.body)),
    signal: options.signal ?? new AbortController().signal,
  };
}

const authorized = { authorization: "Bearer good", "x-access": "allow" };

test("routes answer with their exposure's value, status and input from path, query and body", async () => {
  const app = await start();
  try {
    const router = app.resolve(restRouter);
    assert.deepEqual(await router.handle(request("POST", "/roles", { body: { name: "admin" }, headers: authorized })), {
      status: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "r1", name: "admin", actor: { userId: "u1" } }),
    });
    const fetched = await router.handle(request("GET", "/roles/r%201?verbose=yes"));
    assert.deepEqual([fetched.status, fetched.body], [200, JSON.stringify({ id: "r 1" })]);
    assert.equal((await router.handle(request("GET", "/roles/new"))).body, JSON.stringify("new"));
    assert.deepEqual(await router.handle(request("DELETE", "/roles/r1")), { status: 204 });
    assert.deepEqual(await router.handle(request("GET", "/missing")), { status: 404 });
    assert.deepEqual(await router.handle(request("PATCH", "/roles/r1")), {
      status: 405,
      headers: { allow: "GET, DELETE, PUT" },
    });
    await router.handle(request("GET", "/roles/r1", { headers: { traceparent: "00-trace" } }));
    assert.ok(
      spans.some(
        (span) => span.propagation?.traceparent === "00-trace" && span.attributes?.["http.route"] === "/roles/:id",
      ),
    );
  } finally {
    await app.stop();
  }
});

test("input, authentication and guard inputs are checked before the exposure runs", async () => {
  const app = await start();
  try {
    const router = app.resolve(restRouter);
    const invalid = await router.handle(request("POST", "/roles", { body: { name: "" }, headers: authorized }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.body!), {
      type: "InvalidInput",
      message: "The input is invalid.",
      issues: [{ message: JSON.parse(invalid.body!).issues[0].message, path: ["name"] }],
    });
    const shared = await router.handle(request("PUT", "/roles/r1", { body: { id: "r2", name: "x" } }));
    assert.equal(shared.status, 400);
    assert.match(JSON.parse(shared.body!).message, /'id' is both a path parameter and a request field/);
    assert.equal((await router.handle(request("PUT", "/roles/r1", { body: ["x"] }))).status, 400);
    for (const headers of [{}, { authorization: "Basic good" }, { authorization: "Bearer bad" }]) {
      const denied = await router.handle(request("POST", "/roles", { body: { name: "admin" }, headers }));
      assert.deepEqual([denied.status, JSON.parse(denied.body!).type], [401, "ActorAuthenticationError"]);
    }
    const forbidden = await router.handle(
      request("POST", "/roles", { body: { name: "admin" }, headers: { authorization: "Bearer good" } }),
    );
    assert.deepEqual(
      [forbidden.status, JSON.parse(forbidden.body!)],
      [403, { type: "AccessDenied", message: "AccessDenied" }],
    );
  } finally {
    await app.stop();
  }
});

test("errors answer through the route's map and framework defaults, without internal details", async () => {
  const app = await start();
  const router = app.resolve(restRouter);
  try {
    const taken = await router.handle(request("POST", "/roles", { body: { name: "taken" }, headers: authorized }));
    assert.deepEqual([taken.status, JSON.parse(taken.body!)], [409, { taken: "taken" }]);
    const internal = await router.handle(request("POST", "/roles", { body: { name: "explode" }, headers: authorized }));
    assert.deepEqual([internal.status, internal.body], [500, JSON.stringify({ type: "InternalError" })]);
    const conflict = await router.handle(request("PUT", "/roles/r1", { body: { name: "x" } }));
    assert.deepEqual([conflict.status, JSON.parse(conflict.body!).type], [409, "VersionConflict"]);
    const tooLarge = RestBodyError(413, "too large");
    assert.deepEqual(await router.handle(request("PUT", "/roles/r1", { body: tooLarge })), { status: 413 });
    const malformed = await router.handle(request("PUT", "/roles/r1", { body: RestBodyError(400, "malformed JSON") }));
    assert.deepEqual(
      [malformed.status, JSON.parse(malformed.body!)],
      [400, { type: "InvalidInput", message: "malformed JSON" }],
    );
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await router.handle(request("DELETE", "/roles/r1", { signal: controller.signal })), {
      status: 499,
    });
  } finally {
    await app.stop();
  }
  assert.deepEqual(await router.handle(request("DELETE", "/roles/r1")), { status: 503 });
});

test("one exposure takes its route directly, as plug() takes one port's implementation", async () => {
  const single = restRoutes({
    port: removeRole,
    routes: { delete: "/single/:id", input: z.object({ id: z.string() }) },
  });
  const app = await start([single]);
  try {
    assert.deepEqual(await app.resolve(restRouter).handle(request("DELETE", "/single/r1")), { status: 204 });
  } finally {
    await app.stop();
  }
});

test("startup rejects overlapping routes and authentication without an actor resolver", async () => {
  const twice = restRoutes({
    port: expose.compose({ removeRole }),
    routes: { removeRole: { delete: "/roles/:id", input: z.object({ id: z.string() }) } },
  });
  await assert.rejects(start([twice]), /both serve DELETE \/roles\/:id/);
  const renamed = restRoutes({
    port: expose.compose({ getRole }),
    routes: { getRole: { put: "/roles/:roleId", input: z.object({ id: z.string() }) } },
  });
  await assert.rejects(start([renamed]), /names ':roleId' where another route names ':id'/);
  const authenticated = restRoutes({
    port: expose.compose({ newRole }),
    authenticate: true,
    routes: { newRole: { get: "/whoami" } },
  });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: [newRole, authenticated, restRouter].map((source) => ({ source })) })],
      }),
    ),
    /authenticates, but no executionActorResolver is bound/,
  );
});

test("restRoutes() rejects declarations its types also reject", () => {
  const create = (options: object) => Reflect.apply(restRoutes, undefined, [options]);
  const port = expose.compose({ removeRole });
  assert.throws(() => create({ port, routes: {} }), /no route for 'removeRole'/);
  assert.throws(() => create({ port: "removeRole", routes: {} }), /an exposure or an expose\.compose\(\) composition/);
  const route = { delete: "/roles/:id", input: z.object({ id: z.string() }) };
  assert.throws(() => create({ port, routes: { removeRole: route, other: route } }), /'other' is not a member/);
  assert.throws(() => create({ port: removeRole, routes: { removeRole: route } }), /unknown option 'removeRole'/);
  assert.throws(() => create({ port, routes: { removeRole: { ...route, get: "/x" } } }), /exactly one of/);
  assert.throws(
    () => create({ port, routes: { removeRole: { delete: "/roles/:id" } } }),
    /path parameters but no input/,
  );
  assert.throws(() => create({ port, routes: { removeRole: { ...route, delete: "roles" } } }), /starts with \//);
  assert.throws(() => create({ port, routes: { removeRole: { ...route, cache: true } } }), /unknown option 'cache'/);
  assert.throws(
    () => create({ port, errors: { AccessDenied: 200 }, routes: { removeRole: route } }),
    /4xx\/5xx status/,
  );
});

test("readJsonBody keeps characters split across chunks whole and stops at the limit while reading", async () => {
  const bytes = new TextEncoder().encode('{"name":"Zoë"}');
  // Splits the two bytes of "ë" between the chunks.
  const split = bytes.indexOf(0xc3) + 1;
  async function* chunks() {
    yield bytes.subarray(0, split);
    yield bytes.subarray(split);
  }
  const headers = restHeaders({ "content-type": "application/json" });
  assert.deepEqual(await readJsonBody(headers, chunks(), bytes.byteLength), { name: "Zoë" });
  await assert.rejects(readJsonBody(headers, chunks(), bytes.byteLength - 1), { status: 413 });
  assert.equal(
    restHeaders({ accept: ["text/plain", "application/json"] }).get("Accept"),
    "text/plain, application/json",
  );
});
