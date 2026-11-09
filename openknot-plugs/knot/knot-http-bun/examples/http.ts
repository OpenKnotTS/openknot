import { bunHttpServer, httpHandler } from "../src/index.ts";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { z } from "zod";

// The application's own settings, validated at startup
const settings = config({
  API_PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  API_HOST: z.string().default("127.0.0.1"),
});

const handler = unit({
  provides: httpHandler,
  factory: () => (request: Request) =>
    Response.json({
      method: request.method,
      path: new URL(request.url).pathname,
    }),
});

const server = bunHttpServer({
  handler,
  requirements: { settings },
  options: ({ settings }) => ({ port: settings.API_PORT, hostname: settings.API_HOST }),
});

const application = defineApplication({ modules: [providePlugs([server])] });
const app = await runApplication(application);

console.log(`Bun HTTP listening at ${app.resolve(server).url}`);

await app.stopped;
