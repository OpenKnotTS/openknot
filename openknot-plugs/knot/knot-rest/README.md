# @openknot-ts/knot-rest

Serves Flow exposures as plain HTTP/JSON routes: route declarations, matching, input validation, authentication and error-to-status mapping. It imports no HTTP host; [`@openknot-ts/knot-rest-http-node`](../knot-rest-http-node/README.md), [`@openknot-ts/knot-rest-http-bun`](../knot-rest-http-bun/README.md) and [`@openknot-ts/knot-rest-fastify`](../knot-rest-fastify/README.md) serve the same routes natively.

## Usage

```ts
import { expose } from "@openknot-ts/flow";
import { restRoutes } from "@openknot-ts/knot-rest";
import { providePlugs } from "@openknot-ts/wire";

export const roleRoutes = restRoutes({
  port: expose.compose({ createRole: createRoleExposure, getRole: getRoleExposure }),
  authenticate: true,
  errors: { AccessDenied: 403 },
  routes: {
    createRole: {
      post: "/roles",
      input: roleSchema,
      status: 201,
      guards: (request) => ({ access: request.headers.get("x-access") ?? undefined }),
      errors: { RoleNameTaken: (error) => ({ status: 409, body: { role: error.role } }) },
    },
    getRole: { get: "/roles/:id", input: z.object({ id: z.string() }), errors: { RoleNotFound: 404 } },
  },
});

export const transport = providePlugs([roleRoutes]);
// container: modules [..., transport, http, restNodeHttp]
```

## Routes

- `port` is one exposure or an `expose.compose({ ... })` composition, as in `plug()`. One exposure takes its route directly (`restRoutes({ port: renameUser, routes: { post: "/users/rename", input } })`); a composition takes one route per member, checked at compile time.
- Each route has exactly one method key, `get`, `post`, `put`, `patch` or `delete`, whose value is the path: static segments and `:name` parameters.
- Selected route sets merge into `restRouter` at startup. Duplicate method and path, or different parameter names at one position, fail startup.
- Unknown paths answer 404; a known path with another method answers 405 with `Allow`. Literal segments win over parameters.

## Input

The route's Standard Schema `input` validates each request once, as tRPC's `.input()` does; exposures carry no schema. The validated value is the path parameters plus the query (`GET`, `DELETE`) or the JSON body (`POST`, `PUT`, `PATCH`). Query values are strings, repeated keys arrays. Failures answer 400 with `{ type: "InvalidInput", message, issues }`.

## Guards and authentication

`guards(request)` builds the exposure's named guard inputs from `params`, `query` and `headers`. `authenticate: true`, router-wide or per route, reads `Authorization: Bearer <token>` and resolves the actor through Flow's `executionActorResolver`; a missing or rejected credential answers 401.

## Errors

`errors` maps each authored error `type` of the exposure (handler, `view` and guards) to a status, answering `{ type, message }`, or to `(error) => ({ status, body })`. The map is exhaustive across route and router: a new error fails compilation until it has a status. Framework failures have fixed answers:

| Failure | Status | Body |
| --- | --- | --- |
| invalid input, malformed path or JSON | 400 | `{ type: "InvalidInput", … }` |
| `ActorAuthenticationError` | 401 | `{ type, message }` |
| `VersionConflict` | 409 | `{ type, message }` |
| body above the limit (adapter) | 413 | none |
| body that is not `application/json` (adapter) | 415 | none |
| `InputCancelledError`: the client went away | 499 | none |
| `InputUnavailableError`: the application is stopping | 503 | none |
| any other failure | 500 | `{ type: "InternalError" }` |

A failed execution is logged and reported by Flow. A failure of the router's own, such as an output its schema rejects or a mapping that fails, rejects `handle()`, and the adapter answers it through `restFailure`, which logs and reports it once through `unattendedFailures`.

## Responses

The body is the exposure's value as JSON. `status` defaults to 200; `undefined` answers 204. An optional `output` schema encodes the response. Each request carries the client's signal, the actor, trace propagation from the request headers and the `http.request.method` and `http.route` attributes.

## Writing an adapter

| Export | Description |
| --- | --- |
| `restRouter` | The merged router: `handle({ method, path, query, headers, readBody, signal })` resolves to `{ status, headers?, body? }`, and rejects with a failure of its own. |
| `restFailure(failures, failure)` | The 500 an adapter answers when `handle()` rejects, after handing the failure to `unattendedFailures`. |
| `readJsonBody(headers, chunks, limit)` | Checks the content type and length, then reads the native byte stream up to the limit. Rejects with `RestBodyError(400 \| 413 \| 415, message)`. |
| `restHeaders(request.headers)` | Header lookup over a Node-style header record. |
| `restBodyLimit({ requirements?, maxBodySize? })`, `RestBodyOptions` | The body limit: `REST_MAX_BODY_SIZE` (bytes, default 1 MiB, from `restConfig`) unless `maxBodySize` selects another value. |

The signal should abort only when the client goes away, so admitted requests drain while the host stops.

## Tests

[test/routes.test.ts](test/routes.test.ts) covers matching, input, authentication, guards, framework defaults, error maps, 201/204, output, propagation and collisions; [test/routes-types.ts](test/routes-types.ts) route keys, inputs, guards and exhaustive error maps.
