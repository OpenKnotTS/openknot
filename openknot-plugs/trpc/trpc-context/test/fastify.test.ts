import type { TrpcAuthenticationContext } from "../src/index.ts";
import { actorAuthentication } from "../src/index.ts";
import { trpcContextFactory, trpcContext } from "../src/wire.ts";
import { ActorAuthenticationError } from "@openknot-ts/flow";
import { actorResolver, executionActorResolver } from "@openknot-ts/flow/wire";
import { defineApplication, optional, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { initTRPC } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import assert from "node:assert/strict";
import { test } from "node:test";

test("the Wire context works directly with Fastify without the standalone HTTP handler or its configuration", async () => {
  for (const authenticated of [false, true]) {
    const parent = unit({ factory: () => initTRPC.context<TrpcAuthenticationContext>().create() });
    const router = unit({
      requirements: { parent, resolve: optional(executionActorResolver) },
      factory: ({ parent, resolve }) => {
        const procedure = resolve === undefined ? parent.procedure : parent.procedure.use(actorAuthentication(resolve));
        return parent.router({
          who: procedure.query(({ ctx }) => ({
            actor: ctx.actor,
            propagation: ctx.propagation,
            signalAborted: ctx.signal.aborted,
          })),
        });
      },
    });
    const identity = actorResolver({
      resolve: async (token: string) => {
        if (token !== "valid") {
          throw ActorAuthenticationError();
        }
        return { subject: "fastify-user" };
      },
    });
    const app = await runApplication(
      defineApplication({
        modules: [trpcContext, providePlugs([parent, router]), ...(authenticated ? [providePlugs([identity])] : [])],
      }),
      { env: { TRPC_MAX_BODY_SIZE: "unused", PORT: "unused" } },
    );
    const server = fastify();
    try {
      await server.register(fastifyTRPCPlugin, {
        prefix: "/rpc",
        trpcOptions: { router: app.resolve(router), createContext: app.resolve(trpcContextFactory) },
      });
      const response = await server.inject({
        method: "GET",
        url: "/rpc/who",
        headers: { authorization: "Bearer valid", traceparent: "incoming-trace" },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        result: {
          data: {
            ...(authenticated ? { actor: { subject: "fastify-user" } } : {}),
            propagation: { traceparent: "incoming-trace" },
            signalAborted: false,
          },
        },
      });
      const anonymous = await server.inject({ method: "GET", url: "/rpc/who" });
      assert.equal(anonymous.statusCode, authenticated ? 401 : 200);
      if (!authenticated) {
        assert.equal(anonymous.json().result.data.actor, undefined);
      }
      if (authenticated) {
        const invalid = await server.inject({
          method: "GET",
          url: "/rpc/who",
          headers: { authorization: "Bearer invalid" },
        });
        assert.equal(invalid.statusCode, 401);
      }
    } finally {
      await server.close();
      await app.stop();
    }
  }
});
