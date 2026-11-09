import { nodeHttpServer } from "../src/index.ts";
import { unit } from "@openknot-ts/wire";
import type { Resolved } from "@openknot-ts/wire";
import type { RequestListener, Server } from "node:http";

const handler = unit({
  factory: (): RequestListener => (_request, response) => {
    response.end();
  },
});
const settings = unit({ factory: () => ({ port: 0, requestTimeout: 1_234 }) });
const host = nodeHttpServer({
  handler,
  requirements: { settings },
  options: ({ settings }) => ({ requestTimeout: settings.requestTimeout }),
  listen: ({ settings }) => ({ port: settings.port }),
});
declare const value: Resolved<typeof host>;
const native: Server = value.native;
void native;

// @ts-expect-error listen retains native numeric port typing.
nodeHttpServer({ handler, listen: () => ({ port: "not-a-number" }) });
// @ts-expect-error options receives exactly the declared requirements.
nodeHttpServer({ handler, requirements: { settings }, options: ({ missing }) => ({ requestTimeout: missing }) });
