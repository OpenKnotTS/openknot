# @openknot-ts/knot-http-bun

A native `Bun.serve` host with Wire lifecycle, environment configuration and graceful draining. Protocols implement its Fetch handler contract; the host has no protocol, health or Node HTTP dependency.

## Usage

```ts
import { http, httpServer } from "@openknot-ts/knot-http-bun";
import { httpHandler } from "@openknot-ts/knot-http-bun/handler";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";

const handler = unit({
  provides: httpHandler,
  factory: () => (request) => Response.json({ path: new URL(request.url).pathname }),
});

const app = await runApplication(defineApplication({ modules: [providePlugs([handler]), http] }));
console.log(app.resolve(httpServer).url);
await app.stopped;
```

## API

| Export | Description |
| --- | --- |
| `http` | Ready module listing `httpServer`. |
| `httpServer` | The default host resource. Resolves to `HttpServer<Data>`: `{ native, url, listening }`. |
| `bunHttpServer({ handler, requirements?, options? })` | Declares another host with native `BunHttpOptions<Data, Route>` (TLS, routes, WebSockets, Unix sockets). |
| `httpConfig` | The default host's environment configuration. |
| `httpHandler`, `HttpHandler<Data>` | Contract for the fallback `fetch` handler; it receives the native `Request` and `Server<Data>`. |
| `httpMiddleware`, `HttpMiddleware` | Collection contract for `(request, server, next)` middleware. |

The handler and middleware contracts are also exported from `@openknot-ts/knot-http-bun/handler`, without the host.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | TCP port; `0` picks a free port. |
| `HTTP_HOST` | `127.0.0.1` | Bind address. |
| `HTTP_IDLE_TIMEOUT_SECONDS` | Bun default | `0`–`255`; `0` disables the inactivity timeout. |
| `HTTP_MAX_REQUEST_BODY_SIZE` | Bun default | Maximum request body in bytes. |

Precedence: environment, then an `options` object, then the defaults above. `development` defaults to `false`. Combining `unix` with an explicit `PORT` or `HTTP_HOST` is rejected.

## Custom hosts

An `options` object keeps the default environment tuning. An `options(dependencies)` callback replaces it entirely: `httpConfig` is not read, and the callback returns native options from the application's own validated config.

```ts
const settings = config({
  API_PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  API_HOST: z.string().default("127.0.0.1"),
});

const server = bunHttpServer({
  handler: httpHandler,
  requirements: { settings },
  options: ({ settings }) => ({ port: settings.API_PORT, hostname: settings.API_HOST, idleTimeout: 0 }),
});
```

Select it with `providePlugs([server])` instead of `http`. Route and WebSocket data types are inferred from the options:

```ts
const socketHandler = unit({
  factory: (): HttpHandler<{ userId: string }> => (request, server) => {
    if (server.upgrade(request, { data: { userId: "example" } })) return;
    return new Response("Upgrade required", { status: 426 });
  },
});

const socketServer = bunHttpServer({
  handler: socketHandler,
  options: {
    websocket: {
      message(socket, message) {
        socket.send(`${socket.data.userId}: ${message}`);
      },
    },
  },
});
```

## Middleware

Units that provide `httpMiddleware` run in module order and return a response or `next()`'s result. **Middleware wraps the fallback `fetch`; native `routes` bypass it.** A middleware reached only as a dependency does not join. [`@openknot-ts/knot-health-bun`](../knot-health-bun/README.md) serves the health probes this way.

## Lifecycle

- A handler or middleware that throws fails only its own request: the host hands the failure to `unattendedFailures`, which logs it and reports it when a reporter is bound, and answers 500 unless a native `error` option answers it. A handler answers the failures of the executions it invokes, as `trpcHttp` and `restRouter` do: Flow has already logged and reported them, so one it lets through is logged and reported twice.
- `Bun.serve()` listens when constructed, inside the resource's `initialize`, so `native` is available from then on. Missing handlers and invalid configuration fail before acquisition; bind failures and cancelled startups unwind.
- `url` is the bound URL with a trailing slash; build paths with `new URL("/path", server.url)`.
- `app.stop()` awaits native `server.stop()`, which waits for active responses. Open WebSockets are closed with 1001 (going away). Other indefinite streams end in shutdown tasks.
- Bun's idle timeout still applies to requests and streams; see [Bun's server documentation](https://bun.sh/docs/runtime/http/server).

## Examples and tests

Requires Bun 1.4.4+ next to Node and pnpm.

```sh
pnpm build
pnpm --filter @openknot-ts/knot-http-bun test
pnpm --filter @openknot-ts/knot-http-bun example
```

- [examples/http.ts](examples/http.ts) serves JSON with its own `API_PORT`/`API_HOST`.
- [test/server.test.ts](test/server.test.ts) lifecycle and drain; [test/config.test.ts](test/config.test.ts) custom configuration; [test/native.test.ts](test/native.test.ts) middleware, WebSockets and Unix sockets; [test/types.ts](test/types.ts) inference; [test/integration.test.ts](test/integration.test.ts) tRPC's Fetch adapter calling Flow exposures with health middleware.
- See [`@openknot-ts/knot-http-node`](../knot-http-node/README.md) for the Node host.
