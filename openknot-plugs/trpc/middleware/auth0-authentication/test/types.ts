import { auth0Authentication } from "../src/index.ts";
import { ActorAuthenticationError } from "@openknot-ts/flow";
import type { TrpcAuthenticationContext } from "@openknot-ts/trpc-context";
import { authenticationErrorFormatter } from "@openknot-ts/trpc-context";
import { trpcAuthentication } from "@openknot-ts/trpc-context/wire";
import { trpcRouter } from "@openknot-ts/trpc-router";
import type { Resolved } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";
import type { TRPCClientErrorLike } from "@trpc/client";
import { initTRPC } from "@trpc/server";

declare module "@openknot-ts/flow" {
  interface ExecutionTypes {
    readonly actor: { readonly userId: string };
  }
}

export const genericIdentity = trpcRouter({
  requirements: { authentication: trpcAuthentication },
  routes: ({ trpc, authentication }) => ({
    me: trpc.procedure.use(authentication).query(({ ctx }) => {
      const userId: string = ctx.actor.userId;
      return userId;
    }),
  }),
});

const middleware = auth0Authentication({
  issuer: "https://tenant.example.auth0.com/",
  audience: "https://example.test/api",
  mapActor: (claims) => ({ userId: claims.sub }),
});
const authentication = unit({ factory: () => middleware });
export const router = trpcRouter({
  requirements: { authentication },
  routes: ({ trpc, authentication }) => ({
    me: trpc.procedure.use(authentication).query(({ ctx }) => {
      const userId: string = ctx.actor.userId;
      // @ts-expect-error The actor contains only the application's mapped fields.
      void ctx.actor.password;
      return userId;
    }),
  }),
});
declare const failure: TRPCClientErrorLike<Resolved<typeof router>>;
if (ActorAuthenticationError.is(failure.data?.authenticationError)) {
  const type: "ActorAuthenticationError" = failure.data.authenticationError.type;
  void type;
}

const custom = initTRPC
  .context<TrpcAuthenticationContext & { readonly tenant: string }>()
  .meta<{ readonly audit: boolean }>()
  .create({
    errorFormatter: (options) =>
      authenticationErrorFormatter({ ...options, shape: { ...options.shape, tenantError: true as const } }),
  });
custom.procedure
  .meta({ audit: true })
  .use(middleware)
  .input(String)
  .query(({ ctx, input }) => {
    const tenant: string = ctx.tenant;
    const userId: string = ctx.actor.userId;
    return { tenant, userId, input };
  });
const formatterField: true = custom._config.$types.errorShape.tenantError;
void formatterField;

const incompatible = initTRPC.context<{ readonly actor: string }>().create();
// @ts-expect-error Authentication requires a native credential context and a cancellation signal.
incompatible.procedure.use(middleware);
