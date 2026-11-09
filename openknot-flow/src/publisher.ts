import type { TraceOptions } from "./execution.ts";
import { integration } from "./internal/integration.ts";
import { isTransactional, markTransactional } from "./internal/transactional.ts";
import type { CommitContext } from "./unit-of-work.ts";
import type { Bindable, ImplementationBinding } from "@openknot-ts/behavior/internal/bindable";
import { bindable, ImplementationBindingMarker, isBindableBinding } from "@openknot-ts/behavior/internal/bindable";
import type { Tracing } from "@openknot-ts/tracing";
import { BindPort, DefinitionIntegrationMarker, hasMarker } from "@openknot-ts/wire/internal/marker";

export const PublisherMarker = Symbol.for("@openknot-ts/flow/publisher");
export const PublisherBindingMarker = Symbol.for("@openknot-ts/flow/publisher-binding");

export interface PublishOptions extends TraceOptions {
  /** Flow supplies its container's optional integration at delivery; native bindings consume it. */
  readonly tracing?: Tracing | undefined;
  /** A stable identity for the message, which native bindings forward so consumers can recognise a redelivery. */
  readonly messageId?: string | undefined;
}

export type Publish<Message> = (message: Message, options: PublishOptions) => void | PromiseLike<void>;

export interface PublisherDefinition {
  readonly [PublisherMarker]: true;
  readonly kind: "publisher";
}

export interface Publisher<Message>
  extends PublisherDefinition, Bindable<Publish<Message>, PublisherBinding<Message>> {}

export interface PublisherBinding<Message = never> extends ImplementationBinding<Publish<Message>> {
  readonly [PublisherBindingMarker]: true;
  readonly publisher: Publisher<Message>;
}

export type PublicationFactory<Message> = (
  context: CommitContext,
) => Message | undefined | PromiseLike<Message | undefined>;

export interface ResolvedPublisher<Message> {
  publish(message: Message | PublicationFactory<Message>, options?: PublishOptions): Promise<void>;
  publishNow(message: Message, options?: PublishOptions): Promise<void>;
}

/** Output messaging contract. Broker identity and delivery policies belong to its plug. */
export function publisher<Message>(): Publisher<Message> {
  return bindable<Publish<Message>, Publisher<Message>, PublisherBinding<Message>>({
    name: "publisher",
    define: (bindPort) => ({
      [PublisherMarker]: true,
      [DefinitionIntegrationMarker]: integration(),
      kind: "publisher",
      [BindPort]: bindPort,
    }),
    bind: (publisher, implementation) => ({
      [ImplementationBindingMarker]: true,
      [PublisherBindingMarker]: true,
      [DefinitionIntegrationMarker]: integration([publisher]),
      publisher,
      implementation,
    }),
  });
}

export function isPublisher(value: unknown): value is PublisherDefinition {
  return hasMarker(value, PublisherMarker);
}

export function isPublisherBinding(value: unknown): value is PublisherBinding {
  return isBindableBinding(value, PublisherBindingMarker, "publisher", isPublisher);
}

/** Native binding view. UoW staging and factories are added by the execution integration. */
export function resolvePublisher<Message>(binding: PublisherBinding<Message>): {
  readonly publish: (message: Message, options?: PublishOptions) => Promise<void>;
} {
  const resolved = Object.freeze({
    async publish(message: Message, options: PublishOptions = {}): Promise<void> {
      options.signal?.throwIfAborted();
      await binding.implementation(message, options);
    },
  });
  if (isTransactional(binding.implementation)) {
    markTransactional(resolved);
  }
  return resolved;
}
