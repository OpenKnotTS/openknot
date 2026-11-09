import type { GuardOptions, GuardRequest, Guards, NoGuards } from "./guard.ts";
import type { PublicationFactory } from "./publisher.ts";
import type {
  DeliveryOptions,
  SubscriptionBinding,
  SubscriptionDefinition,
  SubscriptionOptions,
} from "./subscription.ts";
import { isSubscription, subscriptionDefinition } from "./subscription.ts";
import type { BindPort } from "@openknot-ts/wire/internal/marker";

const TopicTypes = Symbol.for("@openknot-ts/flow/topic-types");

export interface TopicDefinition extends SubscriptionDefinition {
  readonly kind: "topic";
}

export interface Topic<Key, Message, G extends Guards = NoGuards> extends TopicDefinition {
  readonly guards: G;
  readonly [TopicTypes]?: { readonly key: Key; readonly message: Message };
  [BindPort](implementation: TopicImplementation<Key, Message>): SubscriptionBinding<Topic<Key, Message, G>>;
}

export interface TopicImplementation<Key, Message> {
  publish(key: Key, message: Message, options: DeliveryOptions): void | PromiseLike<void>;
  subscribe(key: Key, options: SubscriptionOptions): AsyncIterable<Message> | PromiseLike<AsyncIterable<Message>>;
}

export type TopicKey<T> = T extends Topic<infer K, infer _M, infer _G> ? K : never;
export type TopicMessage<T> = T extends Topic<infer _K, infer M, infer _G> ? M : never;
export type SubscriptionRequest<T extends TopicDefinition> = GuardRequest<TopicKey<T>, T["guards"]>;

export interface ResolvedTopic<T extends TopicDefinition> {
  publish(
    key: TopicKey<T>,
    message: TopicMessage<T> | PublicationFactory<TopicMessage<T>>,
    options?: DeliveryOptions,
  ): Promise<void>;
  publishNow(key: TopicKey<T>, message: TopicMessage<T>, options?: DeliveryOptions): Promise<void>;
  subscribe(request: SubscriptionRequest<T>): Promise<AsyncIterable<TopicMessage<T>>>;
}

export interface TopicFactory<K, M> {
  <const G extends Guards>(options: GuardOptions<G> & { readonly guards: G }): Topic<K, M, G>;
  (options: GuardOptions<undefined>): Topic<K, M>;
}

/** Keyed subscription contract; native delivery is supplied with plug(). */
export function topic<Key, Message>(): TopicFactory<Key, Message> {
  return ((options: GuardOptions<Guards | undefined>) => subscriptionDefinition("topic", options)) as TopicFactory<
    Key,
    Message
  >;
}

export function isTopic(value: unknown): value is TopicDefinition {
  return isSubscription(value) && value.kind === "topic";
}
