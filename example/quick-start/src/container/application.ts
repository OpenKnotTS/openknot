import { createRoleExposure, getStateExposure } from "../app/flow/exposures.ts";
import { roleChangedListener } from "../app/flow/listeners.ts";
import { channels } from "../plugs/channels/index.ts";
import { io } from "../plugs/io/index.ts";
import { transport } from "../plugs/transport/index.ts";
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
