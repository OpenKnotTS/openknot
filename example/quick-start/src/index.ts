import { application } from "./container/application.ts";
import { accessConfig } from "./plugs/io/index.ts";
import { httpServer } from "@openknot-ts/knot-http-node";
import { runApplication } from "@openknot-ts/wire";

const app = await runApplication(application);

console.log(`Role API listening at ${app.resolve(httpServer).url}`);
console.log(`Example token: ${app.resolve(accessConfig).ACCESS_TOKEN}`);

await app.stopped;

console.log("Role API stopped.");
