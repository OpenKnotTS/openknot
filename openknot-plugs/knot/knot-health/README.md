# @openknot-ts/knot-health

Serves the [`@openknot-ts/health`](../../../openknot-capabilities/health/README.md) probes over HTTP: as middleware for the Node host and as a plugin for the [Fastify host](../../fastify/fastify-server/README.md). It owns probe routing, framing and paths; the host owns listening, the health core owns the probe semantics.

## Usage

```ts
import { healthHttp } from "@openknot-ts/knot-health";
import { http } from "@openknot-ts/knot-http-node";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({
  modules: [applicationModule, transport, http, trpcHttp, healthHttp],
});
```

On Fastify, use the module of the same name from `/fastify`:

```ts
import { fastifyHttp } from "@openknot-ts/fastify-server";
import { healthHttp } from "@openknot-ts/knot-health/fastify";

export const application = defineApplication({ modules: [applicationModule, fastifyHttp, healthHttp] });
```

The Bun host uses [`@openknot-ts/knot-health-bun`](../knot-health-bun/README.md). Selecting the health core alone adds no endpoints.

## API

| Entry | Export | Description |
| --- | --- | --- |
| `@openknot-ts/knot-health` | `healthHttp` | Ready Node module: probe middleware before the application handler. |
| | `nodeHealthMiddleware({ requirements?, paths? })` | Node middleware with custom paths. |
| | `healthHttpConfig` | The default path configuration. |
| `@openknot-ts/knot-health/fastify` | `healthHttp`, `fastifyHealthPlugin({ requirements?, paths? })` | The same for the Fastify host. |
| `@openknot-ts/knot-health/probes` | `probeSettings`, `ProbePaths`, `ProbeOptions` | Host-neutral routing, configuration and framing for other host adapters. |

## Configuration

| Variable | Default | Probe |
| --- | --- | --- |
| `HTTP_LIVENESS_PATH` | `/livez` | Liveness |
| `HTTP_READINESS_PATH` | `/readyz` | Readiness |
| `HTTP_HEALTH_PATH` | `/health` | Readiness plus dependency checks |

Paths must start with `/` and differ; invalid or duplicate paths fail before the host listens. `paths(dependencies)` returns `{ liveness, readiness, health }` from the application's own config and replaces these variables entirely.

## Responses

- `GET` and `HEAD` answer 200 when up, 503 when down, with `Cache-Control: no-store` and the body `{ "status": "up" | "down" }` (none for `HEAD`). Query strings do not affect matching.
- Other paths and methods pass to the application unchanged.
- A closed request aborts the dependency checks' signal.
- Readiness is down during startup and from the moment the application starts stopping; a failing dependency affects only `/health`.

## Tests

[test/probes.test.ts](test/probes.test.ts) covers lifecycle phases, dependency failures, `HEAD`, cancellation and paths; [test/config.test.ts](test/config.test.ts) custom paths; [test/fastify.test.ts](test/fastify.test.ts) the Fastify plugin. Both main examples select the Node adapter.
