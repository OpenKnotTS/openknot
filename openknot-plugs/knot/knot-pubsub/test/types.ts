import { inMemoryBroadcast, inMemoryTopic } from "../src/index.ts";
import type { InMemoryTopic } from "../src/index.ts";
import { broadcast, topic } from "@openknot-ts/flow";
import type { BroadcastImplementation, TopicImplementation } from "@openknot-ts/flow";
import { plug, resource } from "@openknot-ts/wire";
import { EventEmitter } from "node:events";

type Key = { readonly userId: string; readonly roleId: number };
type Message = { readonly type: "Changed"; readonly name: string };
const events = new EventEmitter<{ logs: [Message]; [key: `roles:${string}`]: [Message] }>();
const roles = topic<Key, Message>()({});
const logs = broadcast<Message>()({});
const roleDelivery = resource({
  initialize: () => inMemoryTopic<Key, Message>({ events, event: (key) => `roles:${key.userId}:${key.roleId}` }),
});
const logDelivery = resource({ initialize: () => inMemoryBroadcast<Message>({ events, event: "logs" }) });
export const bindings = {
  roles: plug({
    port: roles,
    requirements: { roleDelivery },
    bind: ({ roleDelivery }) => {
      const implementation: TopicImplementation<Key, Message> = roleDelivery;
      const keys: readonly Key[] = roleDelivery.keys();
      void keys;
      return implementation;
    },
  }),
  logs: plug({
    port: logs,
    requirements: { logDelivery },
    bind: ({ logDelivery }) => {
      const implementation: BroadcastImplementation<Message> = logDelivery;
      return implementation;
    },
  }),
};
export function typeErrors(delivery: InMemoryTopic<Key, Message>) {
  delivery.publish({ userId: "alice", roleId: 1 }, { type: "Changed", name: "Dispatcher" });
  // @ts-expect-error A structured topic cannot be published with a string key.
  delivery.publish("alice", { type: "Changed", name: "Dispatcher" });
  // @ts-expect-error A different event is not allowed by the message contract.
  delivery.publish({ userId: "alice", roleId: 1 }, { type: "Deleted", name: "Dispatcher" });
  // @ts-expect-error Backend implementations receive routing keys, not guardable request envelopes.
  delivery.subscribe({ input: { userId: "alice", roleId: 1 }, access: "token" });
}
