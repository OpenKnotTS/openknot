import { channels } from "@modular/channels";
import { createRoleExposure, getStateExposure, roleChangedListener } from "@modular/flow";
import { io } from "@modular/io";
import { transport } from "@modular/transport";
import { healthHttp } from "@openknot-ts/knot-health";
import { http } from "@openknot-ts/knot-http-node";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { defineApplication } from "@openknot-ts/wire";

export const application = defineApplication({
  // The application's input ports; what they need is followed through their requirements
  inputs: [createRoleExposure, getStateExposure, roleChangedListener],

  modules: [
    // The implementations the application selects
    io,
    channels,
    transport,

    // HTTP host, tRPC handler and health probes
    http,
    trpcHttp,
    healthHttp,
  ],
});
