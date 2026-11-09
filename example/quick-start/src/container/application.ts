import { behavior } from "../app/behavior/index.ts";
import { flow } from "../app/flow/index.ts";
import { channels } from "../plugs/channels/index.ts";
import { io } from "../plugs/io/index.ts";
import { transport } from "../plugs/transport/index.ts";
import { healthHttp } from "@openknot-ts/knot-health";
import { http } from "@openknot-ts/knot-http-node";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({
  modules: [
    // The application and its plugs
    behavior,
    flow,
    io,
    channels,
    transport,

    // HTTP host, tRPC handler and health probes
    http,
    trpcHttp,
    healthHttp,
  ],
});
