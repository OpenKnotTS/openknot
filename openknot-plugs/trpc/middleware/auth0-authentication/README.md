# @openknot-ts/auth0-authentication

Native tRPC authentication middleware over [`@openknot-ts/auth0-actor`](../../../auth0/auth0-actor/README.md)'s `auth0Resolver`. Configure issuer, audience and `mapActor`, then use it on a protected procedure. No JWT SDK import or verifier callback is needed.

## Usage

```ts
import { auth0Authentication } from "@openknot-ts/auth0-authentication";
import { trpcRouter } from "@openknot-ts/trpc-router";
import { config, providePlugs, unit } from "@openknot-ts/wire";
import { z } from "zod";

const settings = config({
  AUTH0_ISSUER: z.url(),
  AUTH0_AUDIENCE: z.string().min(1),
});

const authentication = unit({
  requirements: { settings },
  factory: ({ settings }) =>
    auth0Authentication({
      issuer: settings.AUTH0_ISSUER,
      audience: settings.AUTH0_AUDIENCE,
      mapActor: (claims) => ({ userId: claims.sub }),
    }),
});

export const router = trpcRouter({
  requirements: { authentication, getProfileExposure },
  routes: ({ trpc, authentication, getProfileExposure }) => {
    const protectedProcedure = trpc.procedure.use(authentication);

    return {
      me: protectedProcedure.query(getProfileExposure),
      ping: trpc.procedure.query(() => "public"),
    };
  },
});

export const transport = providePlugs([authentication, router]);
```

The Auth0 plug verifies RS256 tokens, issuer, audience, required `exp`/`sub` and optional `nbf`, with native JWKS caching; only verified claims reach `mapActor`. [`provideAuth0`](../../../auth0/auth0-actor/README.md) with `trpcAuthentication` is the other way to compose the same resolver; choose one per application.

## Behavior

- Credentials stay in the context ([`createTrpcContext()`](../../trpc-context/README.md)); verification starts only when a protected procedure runs. Flow receives the actor, signal and propagation, never credentials.
- One middleware instance verifies once per HTTP batch or WebSocket connection; a verification that could not finish is retried.
- Invalid credentials throw `ActorAuthenticationError` as the cause of an `UNAUTHORIZED` `TRPCError`; the default formatter exposes only `{ type, message }` in `error.data.authenticationError`. JWKS outages stay server errors.
- Admitted live subscriptions are not revalidated when the token expires.

| Transport | Credentials | Failure |
| --- | --- | --- |
| HTTP query/mutation | `Authorization: Bearer TOKEN` | tRPC error, HTTP 401 |
| SSE subscription | The same header | Error event in the stream |
| WebSocket | `connectionParams: { token: "TOKEN" }` or the header | tRPC error message |

A header wins over connection parameters, which only tRPC's WebSocket adapter reads; URL parameters never authenticate HTTP or SSE. Browser SSE needs a header-capable EventSource through `httpSubscriptionLink` options.

Custom native instances use `TrpcAuthenticationContext` and `authenticationErrorFormatter`:

```ts
const trpc = initTRPC.context<TrpcAuthenticationContext>().create({
  errorFormatter: authenticationErrorFormatter,
});

if (ActorAuthenticationError.is(error.data?.authenticationError)) {
  // Ask the user to authenticate again.
}
```

## Tests

`pnpm --filter @openknot-ts/auth0-authentication test` uses signed JWTs and a local JWKS server over real HTTP batches, SSE and WebSocket clients; no tenant or credentials are needed.
