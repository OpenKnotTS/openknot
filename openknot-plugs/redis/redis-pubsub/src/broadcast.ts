import type { RedisPubSubOptions } from "./native.ts";
import { redisPubSub } from "./native.ts";
import type { BroadcastImplementation, DeliveryOptions } from "@openknot-ts/flow";
import type { ResourceHandle } from "@openknot-ts/wire";

export interface RedisBroadcast<Message> extends BroadcastImplementation<Message> {
  publish(message: Message, options?: DeliveryOptions): Promise<void>;
  subscribe(options?: DeliveryOptions): Promise<AsyncIterableIterator<Message, void>>;
}

export interface RedisBroadcastOptions<Message> extends RedisPubSubOptions<Message> {
  readonly channel: string;
}

export async function redisBroadcast<Message>(
  options: RedisBroadcastOptions<Message>,
): Promise<ResourceHandle<RedisBroadcast<Message>>> {
  const { channel } = options;
  const managed = await redisPubSub<void, Message>({ ...options, channel: () => channel });
  return {
    value: Object.freeze({
      publish: (message: Message, execution?: DeliveryOptions) => managed.value.publish(undefined, message, execution),
      subscribe: (execution?: DeliveryOptions) => managed.value.subscribe(undefined, execution),
    }),
    release: () => managed.release(),
  };
}
