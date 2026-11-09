import type { NodeEventName, InMemoryPubSubOptions } from "./native.ts";
import { inMemoryPubSub } from "./native.ts";
import type { BroadcastImplementation, DeliveryOptions } from "@openknot-ts/flow";
import type { ResourceHandle } from "@openknot-ts/wire";

export interface InMemoryBroadcast<Message> extends BroadcastImplementation<Message> {
  publish(message: Message, options?: DeliveryOptions): void;
  subscribe(options?: DeliveryOptions): AsyncIterableIterator<Message, void>;
  subscriberCount(): number;
}
export interface InMemoryBroadcastOptions extends InMemoryPubSubOptions {
  readonly event: NodeEventName;
}
export function inMemoryBroadcast<Message>(
  options: InMemoryBroadcastOptions,
): Promise<ResourceHandle<InMemoryBroadcast<Message>>> {
  const { event } = options;
  const native = inMemoryPubSub<void, Message>({ ...options, event: () => event });
  async function open(): Promise<ResourceHandle<InMemoryBroadcast<Message>>> {
    const managed = await native;
    return {
      value: Object.freeze({
        publish: (message: Message, execution?: DeliveryOptions) =>
          managed.value.publish(undefined, message, execution),
        subscribe: (execution?: DeliveryOptions) => managed.value.subscribe(undefined, execution),
        subscriberCount: () => managed.value.subscriberCount(),
      }),
      release: () => managed.release(),
    };
  }
  return open();
}
