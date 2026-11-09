# @openknot-ts/trpc-router

Declares tRPC routers as Wire units, with exact router and client types, and supplies the default native tRPC instance. It has no HTTP host or adapter dependency: [`@openknot-ts/trpc-knot-server-handler`](../trpc-knot-server-handler/README.md) and [`@openknot-ts/trpc-fastify`](../trpc-fastify/README.md) serve the routers.

## Usage

```ts
import { http } from "@openknot-ts/knot-http-node";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { trpcRouter } from "@openknot-ts/trpc-router";
import type { Resolved } from "@openknot-ts/wire";
import { defineApplication, providePlugs } from "@openknot-ts/wire";

export const router = trpcRouter({
  requirements: { createRoleExposure },
  routes: ({ trpc, createRoleExposure }) => ({
    createRole: trpc.procedure.input(createRoleSchema).mutation(createRoleExposure),
  }),
});

export type AppRouter = Resolved<typeof router>;
export const transport = providePlugs([router]);

export const application = defineApplication({
  modules: [behavior, flow, io, channels, transport, http, trpcHttp],
});
```

The handler merges the routers the selected modules list. A router reached only as a dependency is not exposed. No routers, duplicate procedure paths or incompatible formatters fail at startup.

## API

| Export | Description |
| --- | --- |
| `trpcRouter({ requirements?, trpc?, routes })` | Declares a router. `routes` receives the native `trpc` object and the declared dependencies. |
| `trpcRouter.compose({ routers })` | Composes routers under named prefixes (`client.roles.*`). |
| `trpc` | The default native instance: `{ isDev: false, errorFormatter: authenticationErrorFormatter }` over `TrpcAuthenticationContext`, created per application. Rebind it with `unit({ provides: trpc, ... })`. |
| `trpcRootRouter` | The merged root router that handlers serve. |

## Flow inputs in routes

Inside `routes`, each required exposure is a native resolver, and a topic or broadcast's `subscribe` is one:

```ts
routes: ({ trpc, createRole, updateRole, logs }) => ({
  createRole: trpc.procedure.input(createRoleSchema).mutation(createRole),

  // The procedure says where a named guard input comes from.
  updateRole: trpc.procedure
    .input(updateRoleSchema)
    .mutation(({ input, ctx }) => updateRole({ input, ctx, access: ctx.token })),

  logs: trpc.procedure.subscription(logs.subscribe),
}),
```

- A resolver forwards the input, named guard inputs and `traceAttributes`, takes the actor and propagation from the context, and returns the value or throws the error.
- Cancelled and unavailable inputs reject with their tRPC codes; mapping authored errors stays with the application.
- Queries and mutations follow the context's signal; subscriptions follow the resolver's own signal.
- To transform a result, call the resolver: `.query(async (options) => toDto(await getState(options)))`.
- A guard named `ctx`, `path` or `batchIndex` fails at startup.

Outside `routes` the references are ordinary Flow invokers. Routers declared without `trpcRouter()` use [`invokeFlow`](../trpc-context/README.md).

## Feature routers

```ts
export const api = trpcRouter.compose({ routers: { roles, logs } });
export type AppRouter = Resolved<typeof api>;
export const transport = providePlugs([api]);
```

Several flat routers can be typed with tRPC's `TRPCMergeRouters<[Resolved<typeof roles>, Resolved<typeof logs>]>`.

## Custom instances

Different context, meta, formatter or transformer types use a typed reference:

```ts
const customTrpc = unit({ factory: () => initTRPC.context<CustomContext>().meta<CustomMeta>().create(nativeOptions) });

const router = trpcRouter({
  trpc: customTrpc,
  routes: ({ trpc }) => ({
    /* native procedures with CustomContext / CustomMeta inference */
  }),
});
```

Protect procedures with `trpcAuthentication` from `@openknot-ts/trpc-context/wire`, or [`@openknot-ts/auth0-authentication`](../middleware/auth0-authentication/README.md), through `.use()` on a common procedure.

## Tests

`pnpm --filter @openknot-ts/trpc-router test` covers router types, composition and imports without a host.
