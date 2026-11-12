import { unattendedFailures } from "@openknot-ts/error-reporting/wire";
import type { FastifyPlugin } from "@openknot-ts/fastify-server";
import { fastifyPlugins } from "@openknot-ts/fastify-server";
import type { RestBodyOptions } from "@openknot-ts/knot-rest";
import { readJsonBody, restBodyLimit, restFailure, restHeaders, restRouter } from "@openknot-ts/knot-rest";
import { providePlugs, unit } from "@openknot-ts/wire";
import type { Requirements } from "@openknot-ts/wire";

/** A native plugin for the Fastify host serving the selected REST routes; other plugins' own routes take precedence. */
export function fastifyRestPlugin<const R extends Requirements = {}>(
  options: RestBodyOptions<R> = {} as RestBodyOptions<R>,
) {
  return unit({
    provides: fastifyPlugins,
    requirements: { router: restRouter, limit: restBodyLimit(options), failures: unattendedFailures },
    factory:
      ({ router, limit, failures }): FastifyPlugin =>
      async (instance) => {
        // The router reads a body only for routes that take one, under its own limit, so Fastify leaves the stream unread.
        instance.removeAllContentTypeParsers();
        instance.addContentTypeParser("*", (_request, _payload, done) => done(null));
        instance.all("/*", async (request, reply) => {
          const url = new URL(request.url, "http://localhost");
          const headers = restHeaders(request.headers);
          // The signal follows the client only; a stopping host still answers what it admitted.
          const client = new AbortController();
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) {
              client.abort();
            }
          });
          const {
            status,
            headers: responseHeaders,
            body,
          } = await router
            .handle({
              method: request.method,
              path: url.pathname,
              query: url.searchParams,
              headers,
              readBody: () => readJsonBody(headers, request.raw, limit),
              signal: client.signal,
            })
            .catch((failure: unknown) => restFailure(failures, failure));
          // A body the route did not read stays unread, so the connection cannot carry another request.
          const close = status === 413 || status === 415 ? { connection: "close" } : {};
          return reply
            .code(status)
            .headers({ ...responseHeaders, ...close })
            .send(body);
        });
      },
  });
}
export const restFastifyPlugin = fastifyRestPlugin();

/** Opt-in REST protocol for the Fastify host; the selected routes join through the router it requires. */
export const restFastify = providePlugs([restFastifyPlugin]);
