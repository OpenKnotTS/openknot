import { unattendedFailures } from "@openknot-ts/error-reporting/wire";
import type { HttpHandler } from "@openknot-ts/knot-http-bun/handler";
import { httpHandler } from "@openknot-ts/knot-http-bun/handler";
import { readJsonBody, restBodyLimit, restFailure, restRouter } from "@openknot-ts/knot-rest";
import type { RestBodyOptions } from "@openknot-ts/knot-rest";
import { providePlugs, unit } from "@openknot-ts/wire";
import type { Requirements } from "@openknot-ts/wire";

/** The Bun host's fallback fetch handler for the selected REST routes; native Bun routes still bypass it. */
export function bunRestHandler<const R extends Requirements = {}>(
  options: RestBodyOptions<R> = {} as RestBodyOptions<R>,
) {
  return unit({
    requirements: { router: restRouter, limit: restBodyLimit(options), failures: unattendedFailures },
    factory: ({ router, limit, failures }): HttpHandler => {
      return async (request) => {
        const url = new URL(request.url);
        const { status, headers, body } = await router
          .handle({
            method: request.method,
            path: url.pathname,
            query: url.searchParams,
            headers: request.headers,
            readBody: () => readJsonBody(request.headers, request.body, limit),
            // Bun aborts the request's signal when the client goes away, not when the server stops and drains.
            signal: request.signal,
          })
          .catch((failure: unknown) => restFailure(failures, failure));
        return new Response(body ?? null, { status, ...(headers === undefined ? {} : { headers }) });
      };
    },
  });
}
export const restBunHttpHandler = unit({
  provides: httpHandler,
  requirements: { handler: bunRestHandler() },
  factory: ({ handler }) => handler,
});

/** Opt-in REST protocol for the Bun host; the selected routes join through the router it requires. */
export const restBunHttp = providePlugs([restBunHttpHandler]);
