import { collect, unit } from "@openknot-ts/wire";
import type { Serve, Server } from "bun";

/** The native Bun fetch callback, including early return after a WebSocket upgrade. */
export type HttpHandler<Data = undefined> = NonNullable<Serve.Options<Data>["fetch"]>;

/** Protocols bind the default host without importing its implementation. */
export const httpHandler = unit.contract<HttpHandler>();

/** Middleware forwards the original native request/server and preserves the handler's result. */
export type HttpMiddleware = <Data>(
  this: Server<Data>,
  request: Request,
  server: Server<Data>,
  next: () => ReturnType<HttpHandler<Data>>,
) => ReturnType<HttpHandler<Data>>;

/** Only middleware units listed by selected modules join the fallback fetch pipeline. */
export const httpMiddleware = collect.contract<HttpMiddleware>();
