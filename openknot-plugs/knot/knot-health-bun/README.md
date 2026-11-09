# @openknot-ts/knot-health-bun

Serves the `@openknot-ts/health` probes as middleware for [`@openknot-ts/knot-http-bun`](../knot-http-bun/README.md). Paths, settings and responses are those of [`@openknot-ts/knot-health`](../knot-health/README.md), shared through its `/probes` entry, so `HTTP_LIVENESS_PATH`, `HTTP_READINESS_PATH` and `HTTP_HEALTH_PATH` mean the same on every host.

## Usage

```ts
import { healthHttp } from "@openknot-ts/knot-health-bun";
import { http } from "@openknot-ts/knot-http-bun";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({ modules: [applicationModule, http, healthHttp] });
```

## API

| Export | Description |
| --- | --- |
| `healthHttp` | Ready module with the probe middleware. |
| `bunHealthMiddleware({ requirements?, paths? })` | The middleware with paths from the application's own config; replaces the default path variables. |

The middleware wraps the host's fallback `fetch`, so native Bun routes bypass it. The request's own signal, aborted when the client goes away, cancels the dependency checks.

## Tests

[test/probes.test.ts](test/probes.test.ts) serves the probes on a real Bun host, with custom paths and client disconnects.
