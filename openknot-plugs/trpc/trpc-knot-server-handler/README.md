# @openknot-ts/trpc-knot-server-handler

The tRPC handler for the Node host of [`@openknot-ts/knot-http-node`](../../knot/knot-http-node/README.md). It serves the routers of [`@openknot-ts/trpc-router`](../trpc-router/README.md) with the context of [`@openknot-ts/trpc-context`](../trpc-context/README.md).

## Usage

```ts
import { http } from "@openknot-ts/knot-http-node";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { trpcRouter } from "@openknot-ts/trpc-router";
import { defineApplication, providePlugs } from "@openknot-ts/wire";

const router = trpcRouter({
  routes: ({ trpc }) => ({ hello: trpc.procedure.query(() => "Hello!") }),
});

export const application = defineApplication({
  modules: [providePlugs([router]), http, trpcHttp],
});
```

An application selects one handler, `trpcHttp` or its own; two implementations of the handler contract fail at startup.

## API

| Export | Description |
| --- | --- |
| `trpcHttp` | Ready module: merges the selected routers and implements the host's `httpHandler`. |
| `trpcHttpHandler` | Its handler unit. |
| `trpcHttpOptions` | Native handler options, default `{ basePath: "/trpc/" }`; rebind with `unit({ provides: trpcHttpOptions, ... })`. |
| `trpcHttpConfig` | The default environment configuration. |
| `nodeTrpcHandler({ requirements?, options? })` | A handler over the merged routers with native `TrpcHttpOptions` from the application's own config. |
| `trpcHandler({ router, createContext?, requirements?, options?, ...nativeOptions })` | A handler for custom typed routers and contexts. |

Pass a custom handler to `nodeHttpServer({ handler })` and select that host instead of `http` and `trpcHttp`. Custom handlers do not bind the shared contract, so several can run on separate servers.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRPC_BASE_PATH` | `/trpc/` | Mount path; must start with `/`. Requests outside it answer 404. |
| `TRPC_MAX_BODY_SIZE` | tRPC default | Body limit in bytes; `Infinity` removes it. |

Environment values override `trpcHttpOptions`. An `options` callback replaces this configuration entirely:

```ts
const handler = nodeTrpcHandler({
  requirements: { settings },
  options: ({ settings }) => ({ basePath: settings.RPC_PATH, maxBodySize: settings.RPC_LIMIT }),
});
```

Bodies, batching, streaming, SSE cancellation and errors stay native tRPC. WebSocket adapters attach to the host's native server. Health probes come from [`@openknot-ts/knot-health`](../../knot/knot-health/README.md); on Fastify use [`@openknot-ts/trpc-fastify`](../trpc-fastify/README.md).

## Tests

`pnpm --filter @openknot-ts/trpc-knot-server-handler test` covers router collection, typing, configuration, mount boundaries, large bodies, batch streaming, SSE cancellation and real WebSocket clients.
