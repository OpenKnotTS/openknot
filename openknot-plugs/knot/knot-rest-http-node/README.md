# @openknot-ts/knot-rest-http-node

Serves [`@openknot-ts/knot-rest`](../knot-rest/README.md) routes on the native Node host of [`@openknot-ts/knot-http-node`](../knot-http-node/README.md). The router and the selected route sets join through its requirements.

## Usage

```ts
import { http } from "@openknot-ts/knot-http-node";
import { restNodeHttp } from "@openknot-ts/knot-rest-http-node";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({ modules: [behavior, flow, io, transport, http, restNodeHttp] });
```

## API

| Export | Description |
| --- | --- |
| `restNodeHttp` | Ready module: implements the host's `httpHandler`. |
| `nodeRestHandler({ requirements?, maxBodySize? })` | The same with a body limit from the application's own config, which replaces `REST_MAX_BODY_SIZE`. |

## Behavior

- Works on `IncomingMessage` and `ServerResponse` directly.
- Reads a body only for routes that take one: requires `application/json` and enforces `REST_MAX_BODY_SIZE` from `content-length` and while streaming. 413 and 415 close the connection, because the rest of the body stays unread.
- The request's signal aborts when the response closes early, so a client that goes away cancels its execution and rolls its work back. A stopping host still answers what it admitted.

## Custom configuration

```ts
const handler = nodeRestHandler({
  requirements: { settings },
  maxBodySize: ({ settings }) => settings.API_BODY_LIMIT,
});

const server = nodeHttpServer({ handler, listen: ({ settings }) => ({ port: settings.API_PORT }) });
// modules: [..., providePlugs([server])] instead of http and restNodeHttp
```

A custom handler does not bind the shared `httpHandler`, so several native servers can use their own handlers and limits.

## Example and tests

```sh
pnpm --filter @openknot-ts/knot-rest-http-node example
```

[test/http.test.ts](test/http.test.ts) runs on a real host: status codes, limits, a client disconnect that leaves no published or retained work, and a request admitted before stop that is still answered.
