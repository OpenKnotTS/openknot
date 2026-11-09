import { behavior } from "@modular/behavior";
import { channels } from "@modular/channels";
import { flow } from "@modular/flow";
import { io } from "@modular/io";
import { transport } from "@modular/transport";
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
