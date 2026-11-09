import { rabbitTopology } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { listener, publisher } from "@openknot-ts/flow";
import assert from "node:assert/strict";
import { test } from "node:test";

test("topology rejects unknown references and duplicate names from dynamically loaded declarations", () => {
  const invalid: Parameters<typeof rabbitTopology>[0][] = [
    { exchanges: [{ exchange: "roles" }], queues: [], routes: [{ exchange: "unknown", routingKey: "created" }] },
    { exchanges: [], queues: [{ queue: "roles" }], routes: [{ exchange: "", routingKey: "unknown" }] },
    {
      exchanges: [{ exchange: "roles" }],
      queues: [],
      routes: [],
      queueBindings: [{ exchange: "roles", queue: "missing" }],
    },
    {
      exchanges: [{ exchange: "roles" }],
      queues: [],
      routes: [],
      exchangeBindings: [{ source: "roles", destination: "missing" }],
    },
    { exchanges: [{ exchange: "roles" }, { exchange: "roles" }], queues: [], routes: [] },
    { exchanges: [], queues: [{ queue: "roles" }, { queue: "roles" }], routes: [] },
    { exchanges: [{ exchange: "" }], queues: [], routes: [] },
    { exchanges: [], queues: [{ queue: "" }], routes: [] },
  ];
  for (const options of invalid) {
    assert.throws(() => rabbitTopology(options), TypeError);
  }
});

test("bindings require an explicit selection when several queues or publish routes exist", () => {
  const topology = rabbitTopology({
    exchanges: [{ exchange: "roles" }, { exchange: "logs" }],
    queues: [{ queue: "roles.audit" }, { queue: "logs.audit" }],
    routes: [
      { exchange: "roles", routingKey: "created" },
      { exchange: "logs", routingKey: "logged" },
    ],
  });
  const received = listener({ run: () => success() });
  const events = publisher<number>();
  assert.throws(() => topology.rabbitListener(received), /Select a declared Rabbit queue/);
  assert.throws(() => topology.rabbitPublisher(events), /Select a declared Rabbit publish route/);
});
