import type { HttpHandler } from "../src/index.ts";
import { bunHttpServer } from "../src/index.ts";
import { unit } from "@openknot-ts/wire";
import type { Resolved } from "@openknot-ts/wire";
import type { Server } from "bun";

type Client = { readonly userId: string };
const handler = unit({
  factory: (): HttpHandler<Client> => (request, server) => {
    server.upgrade(request, { data: { userId: "user" } });
    // @ts-expect-error Native upgrade data retains the declared shape.
    server.upgrade(request, { data: { userId: 42 } });
  },
});
const host = bunHttpServer({
  handler,
  options: {
    websocket: {
      message(socket, message) {
        const userId: string = socket.data.userId;
        // @ts-expect-error Native WebSocket data is not any.
        const wrong: number = socket.data.userId;
        socket.send(`${userId}: ${message}`);
        void wrong;
      },
    },
    routes: {
      "/users/:id": (request) => {
        const id: string = request.params.id;
        // @ts-expect-error Native route parameters retain the route's exact keys.
        void request.params.missing;
        return new Response(id);
      },
    },
  },
});
declare const resolved: Resolved<typeof host>;
const native: Server<Client> = resolved.native;
void native;
// @ts-expect-error Fetch comes from the injected handler, not a second implementation.
bunHttpServer({ handler, options: { fetch: () => new Response("duplicate") } });
// @ts-expect-error Native Unix and TCP options are mutually exclusive.
bunHttpServer({ handler, options: { unix: "/tmp/http.sock", port: 3000 } });

const settings = unit({ factory: () => ({ port: 0 }) });
const configured = bunHttpServer({
  handler,
  requirements: { settings },
  options: ({ settings }) => ({
    port: settings.port,
    websocket: {
      message(socket, message) {
        const userId: string = socket.data.userId;
        // @ts-expect-error Config mapping must preserve the native WebSocket data type.
        const wrong: number = socket.data.userId;
        socket.send(`${userId}: ${message}`);
        void wrong;
      },
    },
    routes: {
      "/mapped/:id": (request) => {
        const id: string = request.params.id;
        // @ts-expect-error Config mapping must preserve inferred native route parameters.
        void request.params.missing;
        return new Response(id);
      },
    },
  }),
});
declare const configuredValue: Resolved<typeof configured>;
const configuredNative: Server<Client> = configuredValue.native;
void configuredNative;
