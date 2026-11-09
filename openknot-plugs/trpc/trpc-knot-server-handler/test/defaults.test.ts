import { trpcHttp, trpcHttpOptions } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { command, expose, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { http, httpHandler, httpServer, nodeHttpServer } from "@openknot-ts/knot-http-node";
import { trpcRouter } from "@openknot-ts/trpc-router";
import type { Resolved } from "@openknot-ts/wire";
import { defineApplication, override, plug, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { createTRPCClient } from "@trpc/client";
import { httpBatchLink } from "@trpc/client";
import type { TRPCMergeRouters } from "@trpc/server";
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";

/** The current job keeps the objects it created alive until it ends: two turns of the event loop, then a collection. */
async function collect(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc ?? assert.fail("run with node --expose-gc");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  gc();
}

const env = { PORT: "0" };

test("the default host and tRPC handler discover only router definitions listed by selected modules", async () => {
  const privateRouter = trpcRouter({ routes: ({ trpc }) => ({ private: trpc.procedure.query(() => "private") }) });
  const first = trpcRouter({
    requirements: { privateRouter },
    routes: ({ trpc }) => ({ first: trpc.procedure.query(() => "first") }),
  });
  const second = trpcRouter({ routes: ({ trpc }) => ({ second: trpc.procedure.query(() => "second") }) });
  const app = await runApplication(
    defineApplication({
      modules: [http, trpcHttp, providePlugs([first, second])],
    }),
    { env },
  );
  const client = createTRPCClient<TRPCMergeRouters<[Resolved<typeof first>, Resolved<typeof second>]>>({
    links: [httpBatchLink({ url: `${app.resolve(httpServer).url}/trpc` })],
  });
  try {
    assert.deepEqual(await Promise.all([client.first.query(), client.second.query()]), ["first", "second"]);
    assert.equal((await fetch(`${app.resolve(httpServer).url}/trpc/private`)).status, 404);
  } finally {
    await app.stop();
  }
});

test("named router composition preserves native route prefixes and exact client typing", async () => {
  const roles = trpcRouter({ routes: ({ trpc }) => ({ name: trpc.procedure.query(() => "roles") }) });
  const logs = trpcRouter({ routes: ({ trpc }) => ({ count: trpc.procedure.query(() => 2) }) });
  const root = trpcRouter.compose({ routers: { roles, logs } });
  const app = await runApplication(
    defineApplication({
      modules: [http, trpcHttp, providePlugs([root])],
    }),
    { env },
  );
  const client = createTRPCClient<Resolved<typeof root>>({
    links: [httpBatchLink({ url: `${app.resolve(httpServer).url}/trpc` })],
  });
  try {
    assert.deepEqual(await Promise.all([client.roles.name.query(), client.logs.count.query()]), ["roles", 2]);
  } finally {
    await app.stop();
  }
});

test("the configured base path rejects aliases before running native middleware or procedures", async () => {
  let middlewareCalls = 0;
  const router = trpcRouter({ routes: ({ trpc }) => ({ hello: trpc.procedure.query(() => "hello") }) });
  const app = await runApplication(defineApplication({ modules: [http, trpcHttp, providePlugs([router])] }), {
    env,
    overrides: [
      override(trpcHttpOptions, {
        basePath: "/trpc/",
        middleware: (_request, _response, next) => {
          middlewareCalls++;
          next();
        },
      }),
    ],
  });
  try {
    const url = app.resolve(httpServer).url;
    for (const path of ["/fake/hello", "/trpcxhello", "/trpc", "/trpc?hello"]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 404, path);
      await response.body?.cancel();
    }
    // Send the raw path: fetch normalizes dot segments before sending the request.
    for (const path of ["/trpc/../fake/hello", "/trpc\\..\\fake\\hello"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        request(url, { path }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        })
          .once("error", reject)
          .end();
      });
      assert.equal(status, 404, path);
    }
    assert.equal(middlewareCalls, 0);
    const response = await fetch(`${url}/trpc/hello?input=null`);
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(middlewareCalls, 1);
  } finally {
    await app.stop();
  }
});

test("native handler and server options can be overridden while environment configuration wins", async () => {
  const router = trpcRouter({ routes: ({ trpc }) => ({ hello: trpc.procedure.query(() => "hello") }) });
  const server = nodeHttpServer({ handler: httpHandler, options: { keepAliveTimeout: 8_000 } });
  const definition = defineApplication({
    modules: [providePlugs([server]), trpcHttp, providePlugs([router])],
  });
  const app = await runApplication(definition, {
    env: { ...env, TRPC_BASE_PATH: "/api", HTTP_KEEP_ALIVE_TIMEOUT_MS: "9000" },
    overrides: [
      override(trpcHttpOptions, {
        basePath: "/overridden/",
        responseMeta: () => ({ headers: { "x-native": "configured" } }),
      }),
    ],
  });
  try {
    const url = app.resolve(server).url;
    const response = await fetch(`${url}/api/hello`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-native"), "configured");
    assert.equal(app.resolve(server).native.keepAliveTimeout, 9_000);
    assert.equal((await fetch(`${url}/overridden/hello`)).status, 404);
  } finally {
    await app.stop();
  }
});

test("an application selects one HTTP handler: tRPC's or its own, never both", async () => {
  const native = unit({
    provides: httpHandler,
    factory: () => (_request, response) => {
      response.end("custom");
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [http, trpcHttp, providePlugs([native])] }), { env }),
    /multiple implementations supplied/,
  );
  const app = await runApplication(defineApplication({ modules: [http, providePlugs([native])] }), { env });
  try {
    assert.equal(await (await fetch(app.resolve(httpServer).url)).text(), "custom");
  } finally {
    await app.stop();
  }
});

test("missing routers and native path collisions fail during startup", async () => {
  const first = trpcRouter({ routes: ({ trpc }) => ({ duplicate: trpc.procedure.query(() => 1) }) });
  const second = trpcRouter({ routes: ({ trpc }) => ({ duplicate: trpc.procedure.query(() => 2) }) });
  for (const [routers, expected] of [
    [[], /Declare at least one trpcRouter/],
    [[first, second], /Duplicate key/],
  ] as const) {
    await assert.rejects(
      runApplication(
        defineApplication({
          modules: [http, trpcHttp, providePlugs(routers)],
        }),
        { env },
      ),
      expected,
    );
  }
});

test("each request's input and context become unreachable once its response is sent", async () => {
  const kept: WeakRef<object>[] = [];
  const router = trpcRouter({
    routes: ({ trpc }) => ({
      echo: trpc.procedure
        .input((value: unknown) => ({ value: String((value as { value: unknown }).value) }))
        .mutation(({ input, ctx }) => {
          kept.push(new WeakRef(input), new WeakRef(ctx));
          return input.value;
        }),
    }),
  });
  const app = await runApplication(defineApplication({ modules: [http, trpcHttp, providePlugs([router])] }), {
    env,
    stopOn: [],
  });
  try {
    const client = createTRPCClient<Resolved<typeof router>>({
      links: [httpBatchLink({ url: `${app.resolve(httpServer).url}/trpc` })],
    });
    for (let index = 0; index < 20; index++) {
      const values = await Promise.all([1, 2, 3].map((part) => client.echo.mutate({ value: `${index}.${part}` })));
      assert.deepEqual(
        values,
        [1, 2, 3].map((part) => `${index}.${part}`),
      );
    }
    await collect();
    assert.equal(kept.length, 120);
    assert.equal(kept.filter((value) => value.deref() !== undefined).length, 0);
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
  const wait = command({
    requirements: { events },
    async run(_input, ctx) {
      kept.push(new WeakRef(ctx));
      await ctx.events.publish(1);
      entered.resolve();
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      cancelled.resolve();
      return success();
    },
  });
  const endpoint = expose({ handler: wait });
  const router = trpcRouter({
    requirements: { endpoint },
    routes: ({ trpc, endpoint }) => ({ wait: trpc.procedure.mutation(endpoint) }),
  });
  const output = plug({ port: events, bind: () => (value) => void published.push(value) });
  const app = await runApplication(
    defineApplication({ modules: [http, trpcHttp, provideFlow([endpoint]), providePlugs([router, output])] }),
    { env, stopOn: [] },
  );
  try {
    const client = new AbortController();
    const response = fetch(`${app.resolve(httpServer).url}/trpc/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: client.signal,
    });
    await entered.promise;
    client.abort();
    await assert.rejects(response);
    await cancelled.promise;
    // The execution ends once its staged work is discarded, in the turns that follow its cancellation.
    await collect();
    assert.deepEqual(published, []);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.deref(), undefined);
  } finally {
    await app.stop();
  }
});
