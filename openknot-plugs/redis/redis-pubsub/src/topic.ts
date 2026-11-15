import type { RedisPubSubOptions } from "./native.ts";
import { redisPubSub } from "./native.ts";
import type { DeliveryOptions, TopicImplementation } from "@openknot-ts/flow";
import type { ResourceHandle } from "@openknot-ts/wire";

export interface RedisTopic<Key, Message> extends TopicImplementation<Key, Message> {
  publish(key: Key, message: Message, options?: DeliveryOptions): Promise<void>;
  subscribe(key: Key, options?: DeliveryOptions): Promise<AsyncIterableIterator<Message, void>>;
}

export interface RedisTopicOptions<Key, Message> extends RedisPubSubOptions<Message> {
  /** The key's Redis channel: equal channels share a route, and the channel picks the cluster shard. */
  readonly channel: (key: Key) => string;
}

export function redisTopic<Key, Message>(
  options: RedisTopicOptions<Key, Message>,
): Promise<ResourceHandle<RedisTopic<Key, Message>>> {
  return redisPubSub<Key, Message>(options);
}
