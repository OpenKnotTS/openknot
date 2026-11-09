import { healthProbes } from "@openknot-ts/health";
import { probeSettings, isProbeMethod, probeAnswer, probeRoutes } from "@openknot-ts/knot-health/probes";
import type { ProbeOptions } from "@openknot-ts/knot-health/probes";
import { httpMiddleware } from "@openknot-ts/knot-http-bun/handler";
import type { HttpMiddleware } from "@openknot-ts/knot-http-bun/handler";
import { providePlugs, unit } from "@openknot-ts/wire";
import type { Requirements } from "@openknot-ts/wire";

export { healthHttpConfig } from "@openknot-ts/knot-health/probes";

/** A native fallback-fetch middleware for the Bun host; the host never imports health or probe paths. */
export function bunHealthMiddleware<const R extends Requirements = {}>(
  options: ProbeOptions<R> = {} as ProbeOptions<R>,
) {
  return unit({
    provides: httpMiddleware,
    requirements: { health: healthProbes, settings: probeSettings(options) },
    factory: ({ health, settings }): HttpMiddleware => {
      const routes = probeRoutes(health, settings);

      return async (request, _server, next) => {
        const probe = isProbeMethod(request.method) ? routes.get(new URL(request.url).pathname) : undefined;

        if (probe === undefined) {
          return next();
        }

        // Bun aborts the request's signal when the client goes away, which cancels the dependency checks.
        const { status, headers, body } = probeAnswer(await probe(request.signal));
        return new Response(body, { status, headers });
      };
    },
  });
}
export const healthHttpMiddleware = bunHealthMiddleware();

/** Opt-in HTTP adapter for the Bun host: the probes its middleware requires join through that requirement. */
export const healthHttp = providePlugs([healthHttpMiddleware]);
