# @openknot-ts/auth0-actor

Verifies Auth0 access tokens and maps their claims to the application's actor, independently of any transport. It includes `jose` and configures JWT verification and JWKS discovery; applications supply the issuer, audience and `mapActor`.

## Usage

```ts
import { provideAuth0 } from "@openknot-ts/auth0-actor/wire";
import { config } from "@openknot-ts/wire";
import { z } from "zod";

const settings = config({
  AUTH0_ISSUER: z.url(),
  AUTH0_AUDIENCE: z.string().min(1),
});

const identity = provideAuth0({
  requirements: { settings },
  factory: ({ settings }) => ({
    issuer: settings.AUTH0_ISSUER,
    audience: settings.AUTH0_AUDIENCE,
    mapActor: (claims) => ({ userId: claims.sub }),
  }),
});
```

## API

| Entry | Export | Description |
| --- | --- | --- |
| `@openknot-ts/auth0-actor` | `auth0Resolver({ issuer, audience, mapActor, jwks?, verification? })` | An actor resolver, usable without Wire. |
| `@openknot-ts/auth0-actor/wire` | `provideAuth0({ requirements?, factory })` | Provides Flow's `executionActorResolver` when its declared settings are available. |

- `jwks` takes jose's `RemoteJWKSetOptions`: timeouts, headers, caching, `customFetch`.
- `verification` takes native tuning such as clock tolerance, subject, maximum age and extra required claims. It cannot remove the Auth0 contract.

## Verification

- One remote key set per application, at the issuer's `/.well-known/jwks.json`; jose owns fetching, caching and refresh.
- Tokens must be RS256, match the issuer and audience, have a valid `exp` and a non-empty `sub`, and satisfy `nbf` when present. Only verified claims reach `mapActor`, which may be async.
- Invalid tokens, claims and unknown keys produce `ActorAuthenticationError`. JWKS network failures, malformed key sets and mapping failures keep their own identity.
- Raw tokens never reach the actor or telemetry. Business facts such as an event's `createdBy` belong in the event, not in a restored token.

## Transports

tRPC uses this module through `trpcAuthentication` from [`@openknot-ts/trpc-context/wire`](../../trpc/trpc-context/README.md), or [`@openknot-ts/auth0-authentication`](../../trpc/middleware/auth0-authentication/README.md) builds the middleware from the same options. Another RPC calls `auth0Resolver` or the resolved `executionActorResolver` in its own context or middleware and passes the `actor` to Flow.

## Tests

`pnpm --filter @openknot-ts/auth0-actor test` uses real signatures and local JWKS servers: claims, algorithms, unknown keys, caching, infrastructure failures, mapping, cancellation and conditional Wire composition, without an Auth0 tenant.
