import { httpHandler, nodeHttpServer } from "../src/index.ts";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import type { RequestListener } from "node:http";
import { z } from "zod";

// The application's own settings, validated at startup
const settings = config({
  API_PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  API_HOST: z.string().default("127.0.0.1"),
});

const handler = unit({
  provides: httpHandler,
  factory: (): RequestListener => (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, path: request.url }));
  },
});

const server = nodeHttpServer({
  handler,
  requirements: { settings },
  listen: ({ settings }) => ({ port: settings.API_PORT, host: settings.API_HOST }),
});

const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }));

console.log(`Node HTTP listening at ${app.resolve(server).url}`);

await app.stopped;
