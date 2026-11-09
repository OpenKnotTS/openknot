import type { Broadcast, BroadcastImplementation } from "./broadcast.ts";
import type { ExecutionOptions } from "./execution.ts";
import type { GuardOptions, Guards } from "./guard.ts";
import { guardedReferences, snapshotGuardOptions } from "./guard.ts";
import { integration } from "./internal/integration.ts";
import type { PublishOptions } from "./publisher.ts";
import type { Topic, TopicImplementation } from "./topic.ts";
import { BindPort, DefinitionIntegrationMarker, hasMarker } from "@openknot-ts/wire/internal/marker";
import type { NoRequirements } from "@openknot-ts/wire/internal/requirements";

export const SubscriptionMarker = Symbol.for("@openknot-ts/flow/subscription");
export const SubscriptionBindingMarker = Symbol.for("@openknot-ts/flow/subscription-binding");

export interface SubscriptionDefinition {
  readonly [SubscriptionMarker]: true;
  readonly kind: "topic" | "broadcast";
  readonly guards: Guards;
  readonly requirements: NoRequirements;
}

export type SubscriptionImplementation<P> =
  P extends Topic<infer K, infer M, infer _G>
    ? TopicImplementation<K, M>
    : P extends Broadcast<infer M, infer _G>
      ? BroadcastImplementation<M>
      : NativeSubscription;

export interface SubscriptionBinding<P extends SubscriptionDefinition = SubscriptionDefinition> {
  readonly [SubscriptionBindingMarker]: true;
  readonly port: P;
  readonly implementation: SubscriptionImplementation<P>;
}

export interface DeliveryOptions extends PublishOptions {}

/**
 * What a native subscription receives: its signal aborts when the caller cancels or the application begins stopping,
 * so an implementation ends the stream on it and no open stream holds shutdown.
 */
export interface SubscriptionOptions extends ExecutionOptions {
  readonly signal: AbortSignal;
}

/** Erased only inside integration; implementations retain their public signatures. */
export interface NativeSubscription {
  readonly publish: (...args: never[]) => void | PromiseLike<void>;
  readonly subscribe: (...args: never[]) => AsyncIterable<unknown> | PromiseLike<AsyncIterable<unknown>>;
}

export interface SubscriptionContract extends SubscriptionDefinition {
  [BindPort](implementation: NativeSubscription): SubscriptionBinding;
}

export function subscriptionDefinition(
  kind: SubscriptionDefinition["kind"],
  options: GuardOptions<Guards | undefined>,
): SubscriptionContract {
  const { guards } = snapshotGuardOptions(options);
  const requirements = Object.freeze({});
  const definition = Object.freeze({
    [SubscriptionMarker]: true as const,
    kind,
    guards,
    requirements,
    [DefinitionIntegrationMarker]: integration(guardedReferences({ guards, requirements })),
    [BindPort](implementation: NativeSubscription) {
      if (typeof implementation !== "object" || implementation === null) {
        throw new TypeError(`A ${kind}'s implementation requires subscribe and publish functions`);
      }
      const { subscribe, publish } = implementation;
      if (typeof subscribe !== "function" || typeof publish !== "function") {
        throw new TypeError(`A ${kind}'s implementation requires subscribe and publish functions`);
      }
      return Object.freeze({
        [SubscriptionBindingMarker]: true as const,
        [DefinitionIntegrationMarker]: integration([definition]),
        port: definition,
        implementation: Object.freeze({
          subscribe: subscribe.bind(implementation),
          publish: publish.bind(implementation),
        }),
      });
    },
  });
  return definition;
}

export function isSubscription(value: unknown): value is SubscriptionDefinition {
  return hasMarker(value, SubscriptionMarker);
}

export function isSubscriptionBinding(value: unknown): value is SubscriptionBinding {
  return (
    hasMarker(value, SubscriptionBindingMarker) &&
    "port" in value &&
    isSubscription(value.port) &&
    "implementation" in value &&
    typeof value.implementation === "object" &&
    value.implementation !== null &&
    "subscribe" in value.implementation &&
    typeof value.implementation.subscribe === "function" &&
    "publish" in value.implementation &&
    typeof value.implementation.publish === "function"
  );
}
