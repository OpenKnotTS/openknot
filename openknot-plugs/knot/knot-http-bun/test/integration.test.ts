import { success } from "@openknot-ts/behavior";
import { expose, query } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { healthCheck, healthProbes } from "@openknot-ts/health";
import { http, httpHandler, httpMiddleware, httpServer } from "@openknot-ts/knot-http-bun";
import type { HttpHandler, HttpMiddleware } from "@openknot-ts/knot-http-bun/handler";
import { defineApplication, hook, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { test } from "bun:test";
import assert from "node:assert/strict";

test("native Fetch tRPC invokes Flow with isolated concurrent scopes and health follows Wire lifecycle", async () => {
  let acquired = 0;
  let released = 0;
  let entered = 0;
  const both = Promise.withResolvers<void>();
  const session = resource({
    lifetime: "scoped",
    initialize: async () => ({
      value: ++acquired,
      release() {
        released++;
      },
    }),
  });
  const inspect = query<number>()({
    requirements: { session },
    run: async (input, ctx) => {
      if (++entered === 2) {
        both.resolve();
      }
      await both.promise;
      assert.equal(ctx.signal.aborted, false);
      return success({ input, session: ctx.session });
    },
  });
  const api = expose({ handler: inspect });
  const handler = unit({
    provides: httpHandler,
    requirements: { api },
    factory: ({ api }): HttpHandler => {
      const t = initTRPC.context<{ readonly signal: AbortSignal }>().create({ isDev: false });
      const router = t.router({
        inspect: t.procedure
          .input((raw: unknown) => {
            if (typeof raw !== "number") {
              throw new Error("expected number");
            }
            return raw;
          })
          .query(({ input, ctx }) => api({ input, signal: ctx.signal })),
      });
      return (request) =>
        fetchRequestHandler({
          endpoint: "/trpc",
          req: request,
          router,
          createContext: ({ req }) => ({ signal: req.signal }),
        });
    },
  });
  const check = healthCheck({ name: "native", check: async () => "up" });
  const probes = unit({
    provides: httpMiddleware,
    requirements: { healthProbes },
    factory:
      ({ healthProbes }): HttpMiddleware =>
      async (request, _server, next) => {
        const path = new URL(request.url).pathname;
        if (path === "/readyz") {
          const status = healthProbes.readiness();
          return Response.json({ status }, { status: status === "up" ? 200 : 503 });
        }
        if (path === "/health") {
          const report = await healthProbes.health({ signal: request.signal });
          return Response.json(report, { status: report.status === "up" ? 200 : 503 });
        }
        return next();
      },
  });
  const startup = hook({
    requirements: { httpServer },
    run: async ({ httpServer }) => {
      assert.equal((await fetch(new URL("/readyz", httpServer.url))).status, 503);
    },
  });
  const shutdown = hook({
    requirements: { httpServer },
    run: async ({ httpServer }) => {
      assert.equal((await fetch(new URL("/readyz", httpServer.url))).status, 503);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [http, provideFlow([api]), providePlugs([handler, check, probes])],
      startupTasks: [startup],
      shutdownTasks: [shutdown],
    }),
    { env: { PORT: "0" }, stopOn: [] },
  );
  try {
    const url = app.resolve(httpServer).url;
    assert.equal((await fetch(new URL("/readyz", url))).status, 200);
    assert.deepEqual(await (await fetch(new URL("/health", url))).json(), {
      status: "up",
      application: "ready",
      checks: { native: "up" },
    });
    const replies = await Promise.all(
      [1, 2].map(async (input) => {
        const response = await fetch(new URL(`/trpc/inspect?input=${input}`, url));
        assert.equal(response.status, 200);
        return (await response.json()) as { result: { data: { input: number; session: number } } };
      }),
    );
    assert.deepEqual(
      replies.map((reply) => reply.result.data.input),
      [1, 2],
    );
    assert.notEqual(replies[0]!.result.data.session, replies[1]!.result.data.session);
    assert.equal(acquired, 2);
    assert.equal(released, 2);
  } finally {
    both.resolve();
    await app.stop();
  }
});
