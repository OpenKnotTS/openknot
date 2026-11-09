import type { FastifyPlugin } from "../src/index.ts";
import { fastifyHttpServer, fastifyPlugins } from "../src/index.ts";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import fastify from "fastify";
import { z } from "zod";

// The application's own settings, validated at startup
const settings = config({
  FASTIFY_PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(0).max(65_535)).default(3000),
  FASTIFY_HOST: z.string().default("127.0.0.1"),
});

const server = fastifyHttpServer({
  requirements: { settings },
  create: () => fastify(),
  listen: ({ settings }) => ({ port: settings.FASTIFY_PORT, host: settings.FASTIFY_HOST }),
});

// A native Fastify plugin joins the host's plugin collection.
const hello = unit({
  provides: fastifyPlugins,
  factory: (): FastifyPlugin => async (instance) => {
    instance.get<{ Params: { readonly name: string } }>("/hello/:name", async (request) => ({
      hello: request.params.name,
    }));
  },
});

const application = defineApplication({ modules: [providePlugs([hello, server])] });
const app = await runApplication(application);

console.log(`Fastify listening at ${app.resolve(server).url}`);

await app.stopped;
