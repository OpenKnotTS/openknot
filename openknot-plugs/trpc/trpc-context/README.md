# @openknot-ts/trpc-context

The native tRPC request context: it keeps credentials private, resolves the actor in native middleware before protected procedures enter Flow, and selects trace propagation fields. The root entry works with plain tRPC, without Wire.

## API

| Entry | Export | Description |
| --- | --- | --- |
| `@openknot-ts/trpc-context` | `createTrpcContext({ tracing? })` | Context factory returning `TrpcAuthenticationContext`. |
| | `actorAuthentication(resolve)` | Native middleware that supplies a verified `ctx.actor`. |
| | `authenticationErrorFormatter` | Adds public authentication failures to `error.data.authenticationError`. |
| | `invokeFlow(ctx, invoke, request?)`, `flowInput(reference, value)` | Call a Flow input from a procedure. |
| | `TrpcContext`, `TrpcAuthenticationContext`, `TrpcContextFactory`, `TrpcContextInput` | Types. |
| `@openknot-ts/trpc-context/wire` | `trpcContextFactory` | The context factory as a unit, using `optional(trace)`. |
| | `trpcContext` | Module for custom adapters that resolve the factory. |
| | `trpcAuthentication` | `actorAuthentication` over the application's `executionActorResolver`. |

The [Knot server handler](../trpc-knot-server-handler/README.md) and [`@openknot-ts/trpc-fastify`](../trpc-fastify/README.md) require the factory themselves.

## Calling Flow

Routes declared with [`trpcRouter()`](../trpc-router/README.md) receive exposures as native resolvers. Other routers use `invokeFlow`, which forwards only the context's `signal`, `actor` and `propagation`:

```ts
createRole: trpc.procedure.input(createRoleSchema).mutation(({ input, ctx }) => invokeFlow(ctx, createRoleExposure, { input })),
getState: trpc.procedure.query(({ ctx }) => invokeFlow(ctx, getStateExposure)),
```

A cancelled input becomes `CLIENT_CLOSED_REQUEST` and an unavailable one (during shutdown) `SERVICE_UNAVAILABLE`, with the Flow error as `cause`. Other errors reach tRPC unchanged.

## Protected procedures

Supply an actor resolver with `actorResolver({ requirements, resolve })` from `@openknot-ts/flow/wire` or [`provideAuth0`](../../auth0/auth0-actor/README.md), then use `trpcAuthentication`:

```ts
const router = trpcRouter({
  requirements: { authentication: trpcAuthentication, getProfileExposure },
  routes: ({ trpc, authentication, getProfileExposure }) => {
    const protectedProcedure = trpc.procedure.use(authentication);
    return { me: protectedProcedure.query(getProfileExposure) };
  },
});
```

- Missing or invalid credentials answer `UNAUTHORIZED` before Flow admission, with `ActorAuthenticationError` as cause. Infrastructure failures stay server errors.
- Verification is shared within one HTTP request or WebSocket connection. A verification that could not finish, such as an unreachable key set, is retried by the next procedure.
- Public procedures keep `actor: undefined` and verify nothing.
- HTTP and SSE use the bearer header. Only tRPC's WebSocket adapter reads `connectionParams.token`; an explicit header wins. URL credentials never authenticate an HTTP or SSE request.
- The middleware protects procedures and subscription admission, not the WebSocket handshake or the expiry of admitted streams.
- [`@openknot-ts/auth0-authentication`](../middleware/auth0-authentication/README.md) builds the same middleware from Auth0 options.

Augment `ExecutionTypes` from `@openknot-ts/flow` with `readonly actor: AppActor` to type `ctx.actor` everywhere. `propagation` carries only the configured propagator's fields (`traceparent`/`tracestate` by default).

## Custom adapters

`TrpcContextInput` takes native request headers, `info.signal`, optional `info.connectionParams` and `info.url` (`null` from the WebSocket adapter), which the standalone Node, Fastify and WebSocket adapters supply.

```ts
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";

await server.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: { router: app.resolve(router), createContext: app.resolve(trpcContextFactory) },
});
```

## Tests

`pnpm --filter @openknot-ts/trpc-context test` covers context isolation, the WebSocket gate, verification retries, imports without a host and Fastify integration.
