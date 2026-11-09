import type { NodeEventName, InMemoryPubSubOptions } from "./native.ts";
import { inMemoryPubSub } from "./native.ts";
import type { DeliveryOptions, TopicImplementation } from "@openknot-ts/flow";
import type { ResourceHandle } from "@openknot-ts/wire";

export interface InMemoryTopic<Key, Message> extends TopicImplementation<Key, Message> {
  publish(key: Key, message: Message, options?: DeliveryOptions): void;
  subscribe(key: Key, options?: DeliveryOptions): AsyncIterableIterator<Message, void>;
  keys(): readonly Key[];
  subscriberCount(key: Key): number;
}
export interface InMemoryTopicOptions<Key> extends InMemoryPubSubOptions {
  /** Native routing/equality, including namespaces and structured-key encoding, belong here. */
  readonly event: (key: Key) => NodeEventName;
}
export function inMemoryTopic<Key, Message>(
  options: InMemoryTopicOptions<Key>,
): Promise<ResourceHandle<InMemoryTopic<Key, Message>>> {
  return inMemoryPubSub<Key, Message>(options);
}
