import { inMemoryBroadcast, inMemoryTopic } from "../src/index.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import { broadcast, guard, topic } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { defineApplication, plug, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import { EventEmitter } from "node:events";

// Flow: contracts and admission policy
type Audience = { readonly userId: string; readonly roleId: string };
type RoleChanged = { readonly type: "RoleChanged"; readonly name: string };
type LogCreated = { readonly type: "LogCreated"; readonly action: string };

const AccessDenied = error("AccessDenied");

const access = guard<string>()({
  run: (token) => (token === "example-token" ? success() : failure(AccessDenied())),
});

const roles = topic<Audience, RoleChanged>()({ guards: { access } });
const logs = broadcast<LogCreated>()({ guards: { access } });

// Plug: native delivery. The container supplies the emitter and its configuration.
const events = unit({ factory: () => new EventEmitter() });

const roleDelivery = resource({
  requirements: { events },
  initialize: ({ events }) =>
    inMemoryTopic<Audience, RoleChanged>({
      events,
      event: (key) => `roles:${JSON.stringify([key.userId, key.roleId])}`,
    }),
});

const logDelivery = resource({
  requirements: { events },
  initialize: ({ events }) => inMemoryBroadcast<LogCreated>({ events, event: "logs" }),
});

const roleBinding = plug({
  port: roles,
  requirements: { roleDelivery },
  bind: ({ roleDelivery }) => roleDelivery,
});

const logBinding = plug({
  port: logs,
  requirements: { logDelivery },
  bind: ({ logDelivery }) => logDelivery,
});

const app = await runApplication(
  defineApplication({
    modules: [provideFlow([roles, logs]), providePlugs([events, roleDelivery, logDelivery, roleBinding, logBinding])],
  }),
);

try {
  const audience: Audience = { userId: "alice", roleId: "dispatcher" };

  const roleStream = await app.resolve(roles).subscribe({ input: audience, access: "example-token" });
  const logStream = await app.resolve(logs).subscribe({ input: undefined, access: "example-token" });

  const roleMessages = roleStream[Symbol.asyncIterator]();
  const logMessages = logStream[Symbol.asyncIterator]();

  await app.resolve(roles).publish(audience, { type: "RoleChanged", name: "Dispatcher" });
  await app.resolve(logs).publish({ type: "LogCreated", action: "Created Dispatcher" });

  console.log((await roleMessages.next()).value);
  console.log((await logMessages.next()).value);
} finally {
  await app.stop();
}
