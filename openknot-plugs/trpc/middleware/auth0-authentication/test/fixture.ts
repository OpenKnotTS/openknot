import { auth0Authentication } from "../src/index.ts";
import { nativeJwt } from "./native-jwt.ts";
import { failure, success } from "@openknot-ts/behavior";
import { ActorAuthenticationError, broadcast, expose, guard } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { http, httpServer } from "@openknot-ts/knot-http-node";
import { trpcContextFactory } from "@openknot-ts/trpc-context/wire";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { trpcRouter } from "@openknot-ts/trpc-router";
import { defineApplication, plug, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import type { TestContext } from "node:test";

export async function fixture(t: TestContext, subject = "auth0|alice") {
  let executions = 0;
  let admissions = 0;
  let authentications = 0;
  const jwt = await nativeJwt(t, subject);
  const authentication = unit({
    factory: () =>
      auth0Authentication({
        issuer: jwt.issuer,
        audience: jwt.audience,
        mapActor: (claims) => {
          authentications++;
          return { userId: claims.sub };
        },
      }),
  });
  const access = guard({
    run: (_, ctx) => {
      admissions++;
      return typeof ctx.actor === "object" &&
        ctx.actor !== null &&
        "userId" in ctx.actor &&
        ctx.actor.userId === subject
        ? success()
        : failure(ActorAuthenticationError());
    },
  });
  const inspect = expose({
    guards: { access },
    run: (_, ctx) => {
      executions++;
      return success(ctx.actor);
    },
  });
  const changes = broadcast<string>()({ guards: { access } });
  const delivery = plug({
    port: changes,
    bind: () => ({
      publish() {},
      async *subscribe() {
        yield "update";
      },
    }),
  });
  const router = trpcRouter({
    requirements: { authentication, inspect, changes },
    routes: ({ trpc, authentication, inspect, changes }) => {
      const protectedProcedure = trpc.procedure.use(authentication);
      return {
        me: protectedProcedure.query(inspect),
        changes: protectedProcedure.subscription(changes.subscribe),
        ping: trpc.procedure.query(() => "public"),
      };
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([inspect, changes]), providePlugs([authentication, delivery, router]), http, trpcHttp],
    }),
    { env: { PORT: "0", HTTP_HOST: "127.0.0.1", TRPC_BASE_PATH: "/trpc" }, stopOn: [] },
  );
  t.after(() => app.stop());

  return {
    router: app.resolve(router),
    createContext: app.resolve(trpcContextFactory),
    url: `${app.resolve(httpServer).url}/trpc`,
    token: jwt.token,
    respond: jwt.respond,
    counts: () => ({ authentications, executions, admissions }),
  };
}

export type Router = Awaited<ReturnType<typeof fixture>>["router"];
