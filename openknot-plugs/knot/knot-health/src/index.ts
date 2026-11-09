import type { Probe } from "./probes.ts";
import { isProbeMethod, probeAnswer, probeRoutes, probeSettings } from "./probes.ts";
import type { ProbeOptions } from "./probes.ts";
import { healthProbes } from "@openknot-ts/health";
import { httpMiddleware } from "@openknot-ts/knot-http-node/handler";
import type { HttpMiddleware } from "@openknot-ts/knot-http-node/handler";
import { providePlugs, unit } from "@openknot-ts/wire";
import type { Requirements } from "@openknot-ts/wire";
import type { ServerResponse } from "node:http";

export { healthHttpConfig } from "./probes.ts";

async function answer(probe: Probe, response: ServerResponse): Promise<void> {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  const { status, headers, body } = probeAnswer(await probe(controller.signal));
  response.writeHead(status, headers).end(body);
}

/** A plain native middleware implementation for the Node host; the host never imports health or probe paths. */
export function nodeHealthMiddleware<const R extends Requirements = {}>(
  options: ProbeOptions<R> = {} as ProbeOptions<R>,
) {
  return unit({
    provides: httpMiddleware,
    requirements: { health: healthProbes, settings: probeSettings(options) },
    factory: ({ health, settings }): HttpMiddleware => {
      const routes = probeRoutes(health, settings);

      return (request, response, next) => {
        const url = request.url ?? "";
        const query = url.indexOf("?");
        const probe = isProbeMethod(request.method ?? "")
          ? routes.get(query === -1 ? url : url.slice(0, query))
          : undefined;

        if (probe === undefined) {
          return next();
        }

        answer(probe, response).catch(() => response.destroy());
      };
    },
  });
}
export const healthHttpMiddleware = nodeHealthMiddleware();

/** Opt-in HTTP adapter for the Node host: the probes its middleware requires join through that requirement. */
export const healthHttp = providePlugs([healthHttpMiddleware]);
