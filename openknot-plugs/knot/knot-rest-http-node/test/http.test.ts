import { nodeRestHandler, restNodeHttp } from "../src/index.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import { command, expose, publisher, query } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { http, httpServer, nodeHttpServer } from "@openknot-ts/knot-http-node";
import { restRoutes } from "@openknot-ts/knot-rest";
import { config, defineApplication, plug, providePlugs, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

/** The current job keeps the objects it created alive until it ends: two turns of the event loop, then a collection. */
async function collect(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc ?? assert.fail("run with node --expose-gc");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  gc();
}

const RoleNameTaken = error("RoleNameTaken", (role: string) => ({ message: `Role ${role} exists`, role }));
const createRole = expose({
  handler: command<{ readonly name: string }, { readonly id: string; readonly name: string }>()({
    run: (input) =>
      input.name === "taken" ? failure(RoleNameTaken(input.name)) : success({ id: "r1", name: input.name }),
  }),
});
const getRole = expose({
  handler: query<{ readonly id: string; readonly verbose?: string | undefined }, object>()({
    run: (input) => success({ id: input.id, verbose: input.verbose }),
  }),
});
const roleRoutes = restRoutes({
  port: expose.compose({ createRole, getRole }),
  routes: {
    createRole: { post: "/roles", input: z.object({ name: z.string() }), status: 201, errors: { RoleNameTaken: 409 } },
    getRole: { get: "/roles/:id", input: z.object({ id: z.string(), verbose: z.string().optional() }) },
  },
});

test("a custom body limit consumes only the application's validated config", async () => {
  const settings = config({ API_BODY_LIMIT: z.coerce.number().int().nonnegative() });
  const adapter = nodeRestHandler({
    requirements: { settings },
    maxBodySize: ({ settings }) => settings.API_BODY_LIMIT,
  });
  const server = nodeHttpServer({ handler: adapter });
  const definition = defineApplication({
    modules: [providePlugs([server, roleRoutes]), provideFlow([createRole, getRole])],
  });
  const env = { PORT: "0", API_BODY_LIMIT: "32", REST_MAX_BODY_SIZE: "unused" };
  await assert.rejects(
    runApplication(definition, { env: { ...env, API_BODY_LIMIT: "-1" }, stopOn: [] }),
    /API_BODY_LIMIT/,
  );
  const app = await runApplication(definition, { env, stopOn: [] });
  try {
    const url = app.resolve(server).url;
    const response = await send(`${url}/roles`, '{"name":"admin"}');
    assert.deepEqual([response.status, await response.json()], [201, { id: "r1", name: "admin" }]);
    assert.equal((await send(`${url}/roles`, JSON.stringify({ name: "x".repeat(64) }))).status, 413);
  } finally {
    await app.stop();
  }
});

test("independent REST handlers keep separate body limits on separate native servers", async () => {
  const settings = config({
    SMALL_LIMIT: z.coerce.number().int().nonnegative(),
    LARGE_LIMIT: z.coerce.number().int().nonnegative(),
  });
  const smallHandler = nodeRestHandler({
    requirements: { settings },
    maxBodySize: ({ settings }) => settings.SMALL_LIMIT,
  });
  const largeHandler = nodeRestHandler({
    requirements: { settings },
    maxBodySize: ({ settings }) => settings.LARGE_LIMIT,
  });
  const listen = () => ({ port: 0, host: "127.0.0.1" });
  const small = nodeHttpServer({ handler: smallHandler, listen });
  const large = nodeHttpServer({ handler: largeHandler, listen });
  const app = await runApplication(
    defineApplication({
      modules: [providePlugs([small, large, roleRoutes]), provideFlow([createRole, getRole])],
    }),
    { env: { SMALL_LIMIT: "32", LARGE_LIMIT: "128", PORT: "unused", REST_MAX_BODY_SIZE: "unused" }, stopOn: [] },
  );
  try {
    assert.notEqual(app.resolve(small).url, app.resolve(large).url);
    const body = JSON.stringify({ name: "x".repeat(64) });
    const rejected = await send(`${app.resolve(small).url}/roles`, body);
    const accepted = await send(`${app.resolve(large).url}/roles`, body);
    assert.equal(rejected.status, 413);
    assert.deepEqual([accepted.status, await accepted.json()], [201, { id: "r1", name: "x".repeat(64) }]);
  } finally {
    await app.stop();
  }
});

function send(url: string, body: string, contentType = "application/json") {
  return fetch(url, { method: "POST", headers: { "content-type": contentType }, body });
}

test("the Node host serves REST routes with native bodies, limits and status codes", async () => {
  const app = await runApplication(
    defineApplication({
      modules: [http, restNodeHttp, provideFlow([createRole, getRole]), providePlugs([roleRoutes])],
    }),
    { env: { PORT: "0", REST_MAX_BODY_SIZE: "64" }, stopOn: [] },
  );
  try {
    const url = app.resolve(httpServer).url;
    const created = await send(`${url}/roles`, JSON.stringify({ name: "admin" }));
    assert.deepEqual(
      [created.status, created.headers.get("content-type"), await created.json()],
      [201, "application/json", { id: "r1", name: "admin" }],
    );
    const fetched = await fetch(`${url}/roles/r1?verbose=yes`);
    assert.deepEqual([fetched.status, await fetched.json()], [200, { id: "r1", verbose: "yes" }]);
    const taken = await send(`${url}/roles`, JSON.stringify({ name: "taken" }));
    assert.deepEqual(
      [taken.status, await taken.json()],
      [409, { type: "RoleNameTaken", message: "Role taken exists" }],
    );
    assert.equal((await fetch(`${url}/missing`)).status, 404);
    const patched = await fetch(`${url}/roles/r1`, { method: "PATCH" });
    assert.deepEqual([patched.status, patched.headers.get("allow")], [405, "GET"]);
    const text = await send(`${url}/roles`, "name=admin", "text/plain");
    assert.deepEqual([text.status, text.headers.get("connection")], [415, "close"]);
    const malformed = await send(`${url}/roles`, "{");
    assert.deepEqual(
      [malformed.status, ((await malformed.json()) as { readonly type: string }).type],
      [400, "InvalidInput"],
    );
    const large = await send(`${url}/roles`, JSON.stringify({ name: "x".repeat(100) }));
    assert.equal(large.status, 413);
  } finally {
    await app.stop();
  }
});

test("a client that disconnects cancels its execution, rolls its work back and leaves nothing of it", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const published: number[] = [];
  const kept: WeakRef<object>[] = [];
  const events = publisher<number>();
  const wait = expose({
    handler: command({
      requirements: { events },
      async run(_input, ctx) {
        kept.push(new WeakRef(ctx));
        await ctx.events.publish(1);
        entered.resolve();
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
        cancelled.resolve();
        return success();
      },
    }),
  });
  const routes = restRoutes({ port: expose.compose({ wait }), routes: { wait: { post: "/wait" } } });
  const output = plug({ port: events, bind: () => (value) => void published.push(value) });
  const app = await runApplication(
    defineApplication({ modules: [http, restNodeHttp, provideFlow([wait]), providePlugs([routes, output])] }),
    { env: { PORT: "0" }, stopOn: [] },
  );
  try {
    const client = new AbortController();
    const response = fetch(`${app.resolve(httpServer).url}/wait`, { method: "POST", signal: client.signal });
    await entered.promise;
    client.abort();
    await assert.rejects(response);
    await cancelled.promise;
    await collect();
    assert.deepEqual(published, []);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.deref(), undefined);
  } finally {
    await app.stop();
  }
});

test("a request admitted before the application began stopping is still answered, and the server closes", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const slow = expose({
    handler: command({
      async run() {
        entered.resolve();
        await release.promise;
        return success({ done: true });
      },
    }),
  });
  const routes = restRoutes({ port: expose.compose({ slow }), routes: { slow: { post: "/slow" } } });
  const app = await runApplication(
    defineApplication({ modules: [http, restNodeHttp, provideFlow([slow]), providePlugs([routes])] }),
    { env: { PORT: "0" }, stopOn: [] },
  );
  const response = fetch(`${app.resolve(httpServer).url}/slow`, { method: "POST" });
  await entered.promise;
  const stopped = app.stop();
  release.resolve();
  const answered = await response;
  assert.deepEqual([answered.status, await answered.json()], [200, { done: true }]);
  await stopped;
  assert.equal(process.getActiveResourcesInfo().includes("TCPServerWrap"), false);
});
