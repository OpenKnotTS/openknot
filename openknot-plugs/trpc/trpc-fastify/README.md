# @openknot-ts/trpc-fastify

Serves an application's tRPC routers on the [Fastify host](../../fastify/fastify-server/README.md) through tRPC's official `fastifyTRPCPlugin`. The routers of [`trpcRouter()`](../trpc-router/README.md) and the [context factory](../trpc-context/README.md) join through its requirements.

## Usage

```ts
import { fastifyHttp } from "@openknot-ts/fastify-server";
import { trpcFastify } from "@openknot-ts/trpc-fastify";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({ modules: [applicationModule, transport, fastifyHttp, trpcFastify] });
```

## API

| Export | Description |
| --- | --- |
| `trpcFastify` | Ready module joining the host's `fastifyPlugins` collection. |
| `trpcFastifyPlugin` | Its plugin unit. |
| `trpcFastifyOptions` | Native plugin options, default prefix `/trpc`; rebind with `unit({ provides: trpcFastifyOptions, factory })`. |
| `trpcFastifyConfig` | `TRPC_BASE_PATH`, which overrides the prefix. |
| `fastifyTrpcPlugin({ requirements?, options? })` | A plugin with native `TrpcFastifyOptions` (`prefix`, `useWSS`, `trpcOptions`) from the application's own config, replacing `TRPC_BASE_PATH`. |

## Behavior

- Body limits are Fastify's own: pass `bodyLimit` to `fastify(...)` in `fastifyHttpServer({ create })`.
- A client that disconnects aborts its execution and rolls back its Unit of Work; requests admitted before stop still run.
- HTTP subscriptions stream over SSE and end when the application starts stopping. WebSocket subscriptions need `@fastify/websocket` and `useWSS: true`.
- The build skips third-party declaration checks: tRPC 11.22's Fastify declarations use `ws.WebSocket`, which `@types/ws` does not export.

## Example and tests

`pnpm --filter @openknot-ts/trpc-fastify example` runs [examples/trpc.ts](examples/trpc.ts). [test/fastify.test.ts](test/fastify.test.ts) covers base paths, custom options, disconnects with rollback and requests admitted before stop.
