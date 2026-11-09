# @openknot-ts/knot-http-node

A native `node:http` host. It listens, drains admitted requests on shutdown and serves the `(request, response)` handler the application selects. Routing, body parsing and errors belong to the handler; the host has no tRPC, Express, Fastify or WebSocket dependency.

## Usage

```ts
import { http } from "@openknot-ts/knot-http-node";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({
  modules: [transport, http, trpcHttp],
});
```

`http` supplies the host; a protocol module such as `trpcHttp` implements its handler contract. Missing handlers fail at `runApplication()`, before any resource is acquired.

## API

| Export | Description |
| --- | --- |
| `http` | Ready module listing `httpServer`. |
| `httpServer` | The default host resource, configured by `httpConfig`. Resolves to `{ native, url, listening }`. |
| `nodeHttpServer({ handler, requirements?, options?, listen? })` | Declares another host: independent handlers, native options or several servers. |
| `httpConfig` | The default host's environment configuration. |
| `httpHandler` | Contract for the final `RequestListener`; implement it with `unit({ provides: httpHandler, factory })`. |
| `httpMiddleware`, `HttpMiddleware` | Collection contract for native `(request, response, next)` middleware. |

`httpHandler`, `httpMiddleware` and `HttpMiddleware` are also exported from `@openknot-ts/knot-http-node/handler`, which protocols import without loading the host.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | TCP port; `0` picks a free port. |
| `HTTP_HOST` | `127.0.0.1` | Bind address; IPv6 is supported. |
| `HTTP_REQUEST_TIMEOUT_MS` | native (`300000`) | Time to receive the whole request; `0` disables it. |
| `HTTP_HEADERS_TIMEOUT_MS` | native | Time to receive headers; `0` disables it. |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | native (`5000`) | Idle time after a response before the connection closes. |
| `HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS` | native (`1000`) | Extra socket time beyond the advertised keep-alive. |
| `HTTP_SOCKET_TIMEOUT_MS` | native (`0`) | Socket inactivity timeout; disabled so long responses and SSE stay open. |
| `HTTP_MAX_HEADER_SIZE` | native (`16384`) | Maximum header bytes. |
| `HTTP_MAX_HEADERS_COUNT` | native | Maximum header count; `0` removes the limit. |
| `HTTP_MAX_REQUESTS_PER_SOCKET` | native (`0`) | Requests per keep-alive connection; `0` is unlimited. |

Values are validated at startup. Unset tuning variables keep Node's defaults. Precedence: environment, then `options`, then Node defaults.

```sh
env HTTP_KEEP_ALIVE_TIMEOUT_MS=15000 HTTP_REQUEST_TIMEOUT_MS=120000 pnpm example:quickstart
```

## Custom hosts

`options` takes any Node `ServerOptions`, as an object or a callback over `requirements`. `listen` replaces the default `PORT`/`HTTP_HOST` configuration entirely: `httpConfig` is not read and the callback returns native `ListenOptions` (ports, Unix socket `path`, `backlog`, signals).

```ts
const settings = config({
  API_PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  API_HOST: z.string().default("127.0.0.1"),
});

const server = nodeHttpServer({
  handler: httpHandler,
  requirements: { settings },
  options: { highWaterMark: 64 * 1024 },
  listen: ({ settings }) => ({ port: settings.API_PORT, host: settings.API_HOST }),
});
```

Select it with `providePlugs([server])` instead of `http`. Several hosts can run side by side with their own settings. `httpServer.native` is the real `http.Server` for native APIs and events.

## Middleware

Middleware units that provide `httpMiddleware` run in module order before the handler. Each receives the native `(request, response, next)`, may answer or `return next()`, and keeps the server as `this`. A middleware reached only as a dependency does not join the pipeline. [`@openknot-ts/knot-health`](../knot-health/README.md) uses this contract: select its `healthHttp` module to serve `/livez`, `/readyz` and `/health`.

A handler or middleware that throws fails only its own request: the host logs it and answers 500, or closes the connection if headers were already sent.

## Lifecycle

- The host is a Wire resource. It listens before startup tasks run, after Flow's listeners when it serves Flow exposures.
- A failed bind, or a cancelled startup, rejects `runApplication()` and releases the socket. `url` reports the bound address and port.
- On stop, admitted responses get `Connection: close` and finish; idle connections close at once; new requests on open sockets get 503. Nothing truncates admitted work.
- WebSocket servers can attach to `httpServer.native`; their adapter closes their connections. Flow topic and broadcast streams end when the application starts stopping.
- The host serves HTTP/1.1. HTTPS and HTTP/2 need their native servers, such as [`@openknot-ts/fastify-server`](../../fastify/fastify-server/README.md).

## Examples and tests

- `pnpm --filter @openknot-ts/knot-http-node example` runs [examples/http.ts](examples/http.ts) with its own `API_PORT`/`API_HOST`.
- [test/server.test.ts](test/server.test.ts) covers configuration, ordering, startup failure and drain; [test/config.test.ts](test/config.test.ts) custom configuration; [test/middleware.test.ts](test/middleware.test.ts) the pipeline; [test/defaults.test.ts](test/defaults.test.ts) default bindings; [test/portable.test.ts](test/portable.test.ts) the package imports.
- See also [`@openknot-ts/knot-http-bun`](../knot-http-bun/README.md) for the native `Bun.serve` host.
