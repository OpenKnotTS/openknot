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

const BroadcastTypes = Symbol.for("@openknot-ts/flow/broadcast-types");

export interface BroadcastDefinition extends SubscriptionDefinition {
  readonly kind: "broadcast";
}

export interface Broadcast<Message, G extends Guards = NoGuards> extends BroadcastDefinition {
  readonly guards: G;
  readonly [BroadcastTypes]?: Message;
  [BindPort](implementation: BroadcastImplementation<Message>): SubscriptionBinding<Broadcast<Message, G>>;
}

export interface BroadcastImplementation<Message> {
  publish(message: Message, options: DeliveryOptions): void | PromiseLike<void>;
  subscribe(options: SubscriptionOptions): AsyncIterable<Message> | PromiseLike<AsyncIterable<Message>>;
}

export type BroadcastMessage<B> = B extends Broadcast<infer M, infer _G> ? M : never;
export type BroadcastRequest<B extends BroadcastDefinition> = GuardRequest<void, B["guards"]>;

export interface ResolvedBroadcast<B extends BroadcastDefinition> {
  publish(
    message: BroadcastMessage<B> | PublicationFactory<BroadcastMessage<B>>,
    options?: DeliveryOptions,
  ): Promise<void>;
  publishNow(message: BroadcastMessage<B>, options?: DeliveryOptions): Promise<void>;
  subscribe(request: BroadcastRequest<B>): Promise<AsyncIterable<BroadcastMessage<B>>>;
}

export interface BroadcastFactory<M> {
  <const G extends Guards>(options: GuardOptions<G> & { readonly guards: G }): Broadcast<M, G>;
  (options: GuardOptions<undefined>): Broadcast<M>;
}

/** Unkeyed subscription contract; its audience and delivery belong to the implementation. */
export function broadcast<Message>(): BroadcastFactory<Message> {
  return ((options: GuardOptions<Guards | undefined>) =>
    subscriptionDefinition("broadcast", options)) as BroadcastFactory<Message>;
}

export function isBroadcast(value: unknown): value is BroadcastDefinition {
  return isSubscription(value) && value.kind === "broadcast";
}
