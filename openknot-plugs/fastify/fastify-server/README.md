# @openknot-ts/fastify-server

A Fastify host for native Fastify plugins. It owns the instance, listening and graceful draining as a Wire resource; plugins own their routes, parsing, hooks and errors. Fastify is a peer dependency, so the application and its plugins share one Fastify API.

## Usage

```ts
import { fastifyHttp } from "@openknot-ts/fastify-server";
import { healthHttp } from "@openknot-ts/knot-health/fastify";
import { restFastify } from "@openknot-ts/knot-rest-fastify";
import { trpcFastify } from "@openknot-ts/trpc-fastify";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({
  modules: [applicationModule, transport, fastifyHttp, trpcFastify, restFastify, healthHttp],
});
```

An application route is a plugin as well:

```ts
const hello = unit({
  provides: fastifyPlugins,
  factory: (): FastifyPlugin => async (instance) => {
    instance.get("/hello", async () => ({ hello: "world" }));
  },
});
```

## API

| Export | Description |
| --- | --- |
| `fastifyHttp` | Ready module listing `fastifyServer`. |
| `fastifyServer` | The default host: `fastify()` on `PORT`/`HTTP_HOST`. Resolves to `{ native, url, listening }`. |
| `fastifyHttpServer({ requirements?, create, listen? })` | A host over the application's own instance. |
| `fastifyPlugins`, `FastifyPlugin` | Collection of native callback or async plugins, registered in module order before listening. |
| `fastifyHttpConfig` | The default host's environment configuration. |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | TCP port; `0` picks a free port. |
| `HTTP_HOST` | `127.0.0.1` | Bind address. |

## Native instances

`create(dependencies)` builds the instance synchronously during acquisition, with every native option and inferred type: HTTPS, HTTP/2, `serverFactory`, loggers and type providers. `listen(dependencies)` returns native `FastifyListenOptions` (ports, Unix socket `path`, `backlog`, `ipv6Only`, `signal`) and replaces `fastifyHttpConfig` entirely.

```ts
const settings = config({
  FASTIFY_PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(0).max(65_535)),
  FASTIFY_HOST: z.string().default("127.0.0.1"),
});

const server = fastifyHttpServer({
  requirements: { settings, certificates },
  create: ({ certificates }) =>
    fastify({
      http2: true,
      https: { key: certificates.key, cert: certificates.cert, allowHTTP1: true },
      bodyLimit: 2_097_152,
    }),
  listen: ({ settings }) => ({ port: settings.FASTIFY_PORT, host: settings.FASTIFY_HOST }),
});
```

Select it with `providePlugs([server])` instead of `fastifyHttp`; it can run beside a Node host that keeps `PORT`/`HTTP_HOST`. `url` is Fastify's `listeningOrigin`: an HTTP(S) address or a socket path.

## Lifecycle

- Plugins register during acquisition; a plugin that fails rejects startup and closes the instance, as does a cancelled startup.
- A host whose plugins serve Flow exposures starts after Flow's listeners and drains before them.
- Release closes the instance through Fastify. HTTP/1 responses in flight get `Connection: close`; HTTP/2 sessions follow Fastify.

## Example and tests

- `pnpm --filter @openknot-ts/fastify-server example` runs [examples/fastify.ts](examples/fastify.ts) with `FASTIFY_PORT`/`FASTIFY_HOST`.
- [test/server.test.ts](test/server.test.ts) lifecycle and drain; [test/native.test.ts](test/native.test.ts) TLS, HTTP/2, callback plugins, Unix sockets and Node beside Fastify; [test/types.ts](test/types.ts) logger and type-provider inference. The certificate under `test/fixtures` is public test material.
