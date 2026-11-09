import { probeSettings, probeAnswer, probeRoutes } from "./probes.ts";
import type { ProbeOptions } from "./probes.ts";
import type { FastifyPlugin } from "@openknot-ts/fastify-server";
import { fastifyPlugins } from "@openknot-ts/fastify-server";
import { healthProbes } from "@openknot-ts/health";
import { providePlugs, unit } from "@openknot-ts/wire";
import type { Requirements } from "@openknot-ts/wire";

export { healthHttpConfig } from "./probes.ts";

/** A native plugin for the Fastify host: one GET route per probe, with the HEAD route Fastify adds to each. */
export function fastifyHealthPlugin<const R extends Requirements = {}>(
  options: ProbeOptions<R> = {} as ProbeOptions<R>,
) {
  return unit({
    provides: fastifyPlugins,
    requirements: { health: healthProbes, settings: probeSettings(options) },
    factory: ({ health, settings }): FastifyPlugin => {
      const routes = probeRoutes(health, settings);

      return async (instance) => {
        for (const [path, probe] of routes) {
          instance.get(path, async (_request, reply) => {
            // A client that goes away aborts the signal passed to the dependency checks.
            const controller = new AbortController();
            reply.raw.once("close", () => controller.abort());
            const { status, headers, body } = probeAnswer(await probe(controller.signal));
            return reply.code(status).headers(headers).send(body);
          });
        }
      };
    },
  });
}
export const healthHttpPlugin = fastifyHealthPlugin();

/** Opt-in HTTP adapter for the Fastify host: the probes its plugin requires join through that requirement. */
export const healthHttp = providePlugs([healthHttpPlugin]);
