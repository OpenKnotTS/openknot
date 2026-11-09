import { application, client, role } from "./e2e-application.ts";
import { httpServer } from "@openknot-ts/knot-http-node";
import { once } from "node:events";

// The process the crash scenario kills: started with E2E_RUN, a schema and a count, it creates that many roles once
// it reads a line, reports it, and waits to be killed.
const [schema, count] = process.argv.slice(2);
const app = await application({ E2E_SCHEMA: schema! });
const api = client(app.resolve(httpServer).url);
process.stdout.write("ready\n");
await once(process.stdin, "data");
await Promise.all(
  Array.from({ length: Number(count) }, (_, index) => api.createRole.mutate(role(`c${index}`, "Dispatcher"))),
);
process.stdout.write("produced\n");
await app.stopped;
