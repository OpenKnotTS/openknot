import { broadcast, topic, guard } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { plug, composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import { EventEmitter, on } from "node:events";

// Contracts: a keyed topic and a broadcast, both guarded.
const access = guard<string>()({ run: (_token) => success() });
const roles = topic<`roles:${string}`, { readonly id: string }>()({ guards: { access } });
const logs = broadcast<{ readonly action: string }>()({ guards: { access } });

// Native delivery over a Node EventEmitter
const events = unit({ factory: () => new EventEmitter() });

const roleBinding = plug({
  port: roles,
  requirements: { events },
  bind: ({ events }) => ({
    publish: (key, message) => {
      events.emit(key, message);
    },
    subscribe: async function* (key, { signal }) {
      for await (const [message] of on(events, key, { signal })) {
        yield message as { readonly id: string };
      }
    },
  }),
});

const logBinding = plug({
  port: logs,
  requirements: { events },
  bind: ({ events }) => ({
    publish: (message) => {
      events.emit("logs", message);
    },
    subscribe: async function* ({ signal }) {
      for await (const [message] of on(events, "logs", { signal })) {
        yield message as { readonly action: string };
      }
    },
  }),
});

const app = await runApplication(
  defineApplication({
    modules: [provideFlow([roles, logs]), composeModule({ providers: { roleBinding, logBinding } })],
  }),
);

const controller = new AbortController();

try {
  const admission = { access: "token", signal: controller.signal };

  const roleStream = await app.resolve(roles).subscribe({ input: "roles:one", ...admission });
  const logStream = await app.resolve(logs).subscribe({ input: undefined, ...admission });

  const roleMessages = roleStream[Symbol.asyncIterator]();
  const logMessages = logStream[Symbol.asyncIterator]();

  const role = roleMessages.next();
  const log = logMessages.next();

  await app.resolve(roles).publish("roles:one", { id: "one" });
  await app.resolve(logs).publish({ action: "created" });

  console.log((await role).value, (await log).value);

  await roleMessages.return?.();
  await logMessages.return?.();
} finally {
  controller.abort();
  await app.stop();
}
