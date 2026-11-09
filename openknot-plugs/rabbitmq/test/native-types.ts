import { rabbitClient, rabbitTopology } from "../src/index.ts";
import { reader, success } from "@openknot-ts/behavior";
import { listener } from "@openknot-ts/flow";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import type { Resolved } from "@openknot-ts/wire";
import { Connection } from "rabbitmq-client";

const client = rabbitClient({
  create: () =>
    Object.assign(new Connection({ hosts: ["localhost:5672"], tls: { servername: "broker" }, maxChannels: 8 }), {
      nativeMarker: true as const,
    }),
});
const topology = rabbitTopology({ connection: client, exchanges: [], queues: [{ queue: "one" }], routes: [] });
declare const native: Resolved<typeof topology.rabbitNativeConnection>;
const marker: true = native.nativeMarker;
void marker;

const missing = reader<() => string>();
const depends = unit({ requirements: { missing }, factory: () => "unused" });
const custom = rabbitClient({ requirements: { depends }, create: () => new Connection() });
const needs = rabbitTopology({ connection: custom, exchanges: [], queues: [{ queue: "typed" }], routes: [] });
const received = listener({ run: () => success() });
const application = defineApplication({ modules: [providePlugs([needs.rabbitListener(received)])] });
// @ts-expect-error A custom connection's transitive missing contract remains part of the binding graph.
void runApplication(application);
