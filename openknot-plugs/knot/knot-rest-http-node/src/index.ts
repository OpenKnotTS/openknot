import { unattendedFailures } from "@openknot-ts/error-reporting/wire";
import { httpHandler } from "@openknot-ts/knot-http-node/handler";
import type { RestBodyOptions, RestResponse } from "@openknot-ts/knot-rest";
import { readJsonBody, restBodyLimit, restFailure, restHeaders, restRouter } from "@openknot-ts/knot-rest";
import { providePlugs, unit } from "@openknot-ts/wire";
import type { Requirements } from "@openknot-ts/wire";
import type { RequestListener, ServerResponse } from "node:http";

function write(response: ServerResponse, { status, headers, body }: RestResponse): void {
  // A body the route did not read stays unread, so the connection cannot carry another request.
  const close = status === 413 || status === 415 ? { connection: "close" } : {};
  response.writeHead(status, { ...headers, ...close }).end(body);
}

/** The Node host's handler for the selected REST routes. */
export function nodeRestHandler<const R extends Requirements = {}>(
  options: RestBodyOptions<R> = {} as RestBodyOptions<R>,
) {
  return unit({
    requirements: { router: restRouter, limit: restBodyLimit(options), failures: unattendedFailures },
    factory: ({ router, limit, failures }): RequestListener => {
      return (request, response) => {
        let url: URL;
        try {
          url = new URL(request.url ?? "/", "http://localhost");
        } catch {
          write(response, { status: 400 });
          return;
        }
        // The signal follows the client only; a stopping host still answers what it admitted.
        const client = new AbortController();
        response.once("close", () => {
          if (!response.writableFinished) {
            client.abort();
          }
        });
        const headers = restHeaders(request.headers);
        router
          .handle({
            method: request.method ?? "GET",
            path: url.pathname,
            query: url.searchParams,
            headers,
            readBody: () => readJsonBody(headers, request, limit),
            signal: client.signal,
          })
          .then(
            (result) => write(response, result),
            // The router's own failure, which no execution logged: a native middleware need not pass it on.
            (failure: unknown) => write(response, restFailure(failures, failure)),
          );
      };
    },
  });
}
export const restNodeHttpHandler = unit({
  provides: httpHandler,
  requirements: { handler: nodeRestHandler() },
  factory: ({ handler }) => handler,
});

/** Opt-in REST protocol for the Node host; the selected routes join through the router it requires. */
export const restNodeHttp = providePlugs([restNodeHttpHandler]);
