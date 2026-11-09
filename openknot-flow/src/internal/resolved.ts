import type { BroadcastDefinition, ResolvedBroadcast } from "../broadcast.ts";
import type { InputInvoker, InputPortDefinition } from "../definitions.ts";
import type { ExecutableGuard, Guard } from "../guard.ts";
import type { Handler, ResolvedHandler } from "../handlers.ts";
import type { Hook, ResolvedHook } from "../hook.ts";
import type { Publisher, PublisherBinding, ResolvedPublisher } from "../publisher.ts";
import type { SubscriptionBinding } from "../subscription.ts";
import type { TopicDefinition, ResolvedTopic } from "../topic.ts";
import type { UnitOfWorkBinding, UnitOfWorkDefinition } from "../unit-of-work.ts";
import type { Writer, WriterBinding, WriterFunction } from "../writer.ts";
import type { ErrorOf } from "@openknot-ts/behavior";
import type { BehaviorResolved } from "@openknot-ts/behavior/internal/resolved";

/** Closed local mapping. Integration fallbacks belong at the requirement boundary. */
export type FlowResolved<D> =
  D extends Handler<infer I, infer _R, infer O, infer _K>
    ? ResolvedHandler<I, O>
    : D extends Hook<infer I, infer _R, infer O>
      ? ResolvedHook<I, ErrorOf<Awaited<O>>>
      : D extends UnitOfWorkDefinition | UnitOfWorkBinding
        ? { readonly kind: "unit-of-work" }
        : D extends Publisher<infer Message> | PublisherBinding<infer Message>
          ? ResolvedPublisher<Message>
          : D extends SubscriptionBinding<infer P>
            ? FlowResolved<P>
            : D extends TopicDefinition
              ? ResolvedTopic<D>
              : D extends BroadcastDefinition
                ? ResolvedBroadcast<D>
                : D extends InputPortDefinition
                  ? InputInvoker<D>
                  : D extends Guard<infer I, infer _R, infer O>
                    ? ExecutableGuard<I, ErrorOf<Awaited<O>>>
                    : D extends Writer<infer F extends WriterFunction> | WriterBinding<infer F extends WriterFunction>
                      ? F
                      : BehaviorResolved<D>;
