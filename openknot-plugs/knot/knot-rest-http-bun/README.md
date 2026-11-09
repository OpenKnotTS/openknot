# @openknot-ts/knot-rest-http-bun

Serves [`@openknot-ts/knot-rest`](../knot-rest/README.md) routes on the native Bun host of [`@openknot-ts/knot-http-bun`](../knot-http-bun/README.md). The router and the selected route sets join through its requirements.

## Usage

```ts
import { http } from "@openknot-ts/knot-http-bun";
import { restBunHttp } from "@openknot-ts/knot-rest-http-bun";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({ modules: [behavior, flow, io, transport, http, restBunHttp] });
```

## API

| Export | Description |
| --- | --- |
| `restBunHttp` | Ready module: implements the host's Fetch `httpHandler`. |
| `bunRestHandler({ requirements?, maxBodySize? })` | The same with a body limit from the application's own config, which replaces `REST_MAX_BODY_SIZE`. |

## Behavior

- Uses Bun's native `Request` and `Response`, as the host's fallback `fetch`; native Bun `routes` bypass it.
- Reads a body only for routes that take one: requires `application/json` and enforces `REST_MAX_BODY_SIZE` from `content-length` and while streaming.
- Passes `request.signal`, which Bun aborts when the client goes away but not when the server stops, so admitted requests drain.

## Custom configuration

```ts
const handler = bunRestHandler({
  requirements: { settings },
  maxBodySize: ({ settings }) => settings.API_BODY_LIMIT,
});

const server = bunHttpServer({ handler, options: { port: 8080 } });
// modules: [..., providePlugs([server])] instead of http and restBunHttp
```

A custom handler does not bind the shared `httpHandler`, so several native servers can use their own handlers and limits.

## Example and tests

```sh
pnpm --filter @openknot-ts/knot-rest-http-bun example
```

[test/http.test.ts](test/http.test.ts) runs on a real host: status codes, limits, a client disconnect that leaves no published or retained work, and a request admitted before stop that is still answered.
