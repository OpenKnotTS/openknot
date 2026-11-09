import { fastifyHttpServer } from "../src/index.ts";
import type { Resolved } from "@openknot-ts/wire";
import fastify from "fastify";
import type { FastifyBaseLogger, FastifyTypeProvider } from "fastify";
import { createServer } from "node:http";

interface InputTypes extends FastifyTypeProvider {
  readonly validator: { readonly id: string };
  readonly serializer: { readonly id: string };
}

declare const logger: FastifyBaseLogger & { readonly application: true };

const typed = fastifyHttpServer({
  create: () => fastify({ loggerInstance: logger }).withTypeProvider<InputTypes>(),
  listen: () => ({ port: 0 }),
});

declare const value: Resolved<typeof typed>;
const application: true = value.native.log.application;
value.native.post("/typed", { schema: { body: {} } }, (request) => ({ id: request.body.id }));
void application;

const custom = fastifyHttpServer({
  create: () => fastify({ serverFactory: (handler) => createServer(handler) }),
  listen: () => ({ port: 0 }),
});
declare const customValue: Resolved<typeof custom>;
customValue.native.server.setTimeout(1_000);
