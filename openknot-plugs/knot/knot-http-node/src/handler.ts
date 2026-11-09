import { collect, unit } from "@openknot-ts/wire";
import type { RequestListener, Server } from "node:http";

/** Protocol integrations implement this reference; the Node host knows only the native handler. */
export const httpHandler = unit.contract<RequestListener>();

/** Native request middleware either answers the request or forwards it to the next handler. */
export type HttpMiddleware = (
  this: Server,
  request: Parameters<RequestListener>[0],
  response: Parameters<RequestListener>[1],
  next: () => void,
) => void;

/** Only middleware units listed by selected modules join the host's request pipeline. */
export const httpMiddleware = collect.contract<HttpMiddleware>();
