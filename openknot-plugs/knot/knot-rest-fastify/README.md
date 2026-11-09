# @openknot-ts/knot-rest-fastify

Serves [`@openknot-ts/knot-rest`](../knot-rest/README.md) routes on the [Fastify host](../../fastify/fastify-server/README.md). The router and the selected route sets join through its requirements.

## Usage

```ts
import { fastifyHttp } from "@openknot-ts/fastify-server";
import { restFastify } from "@openknot-ts/knot-rest-fastify";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({ modules: [behavior, flow, io, transport, fastifyHttp, restFastify] });
```

## API

| Export | Description |
| --- | --- |
| `restFastify` | Ready module: joins the host's `fastifyPlugins` collection. |
| `fastifyRestPlugin({ requirements?, maxBodySize? })` | The same with a body limit from the application's own config, which replaces `REST_MAX_BODY_SIZE`. |

## Behavior

- Registers one catch-all route in its own encapsulated scope, so routes of other plugins (tRPC, health) take precedence; the router answers 404 and 405 for the rest.
- That scope leaves the request stream unread: the router reads a body only for routes that take one, through `readJsonBody`, with `application/json` and `REST_MAX_BODY_SIZE`. 413 and 415 close the connection. Fastify's `bodyLimit` applies to the other plugins only.
- Responses go through Fastify's reply, so its hooks run.
- The request's signal aborts when the response closes early; a stopping host still answers what it admitted.

## Custom configuration

```ts
const plugin = fastifyRestPlugin({
  requirements: { settings },
  maxBodySize: ({ settings }) => settings.API_BODY_LIMIT,
});
// modules: [..., fastifyHttp, providePlugs([plugin])] instead of restFastify
```



## Example and tests

```sh
pnpm --filter @openknot-ts/knot-rest-fastify example
```

[test/fastify.test.ts](test/fastify.test.ts) runs on a real host: status codes, limits, a client disconnect that leaves no published or retained work, and a request admitted before stop that is still answered.
