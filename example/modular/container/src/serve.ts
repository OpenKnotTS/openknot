import { application } from "./application.ts";
import { accessConfig } from "@modular/io";
import { httpServer } from "@openknot-ts/knot-http-node";
import { runApplication } from "@openknot-ts/wire";

// Ctrl+C (SIGINT) and SIGTERM stop the application by default, even during startup.
const app = await runApplication(application);

console.log(`Role API listening at ${app.resolve(httpServer).url}`);
console.log(`Example token: ${app.resolve(accessConfig).ACCESS_TOKEN}`);

await app.stopped;

console.log("Role API stopped.");
