import type { Broadcast } from "./broadcast.ts";
import type { Publisher, PublisherBinding, PublisherDefinition } from "./publisher.ts";
import { isPublisher, isPublisherBinding, resolvePublisher } from "./publisher.ts";
import type { SubscriptionBinding, SubscriptionDefinition } from "./subscription.ts";
import { isSubscription, isSubscriptionBinding } from "./subscription.ts";
import type { Topic } from "./topic.ts";
import type { UnitOfWorkDefinition, UnitOfWorkBinding } from "./unit-of-work.ts";
import { isUnitOfWork, isUnitOfWorkBinding } from "./unit-of-work.ts";
import type { Writer, WriterBinding, WriterDefinition, WriterFunction, WriterComposition } from "./writer.ts";
import { isWriter, isWriterBinding, isWriterComposition } from "./writer.ts";
import type { Reader, ReaderBinding, ReaderDefinition, ReaderFunction, ReaderComposition } from "@openknot-ts/behavior";
import { isReader, isReaderBinding, isReaderComposition } from "@openknot-ts/behavior";
import type { BindPort } from "@openknot-ts/wire/internal/marker";

export type OutputMember =
  | ReaderDefinition
  | WriterDefinition
  | PublisherDefinition
  | SubscriptionDefinition
  | UnitOfWorkDefinition;

export type OutputPort = OutputMember | ReaderComposition | WriterComposition;

type OutputComposition = ReaderComposition | WriterComposition;

export type OutputMembers<P> = P extends OutputComposition ? P["members"][keyof P["members"]] : P;

/** What a port binds: the implementation an output plug's bind() returns for it. */
export type OutputImplementation<P> = P extends { readonly [BindPort]: (implementation: infer I) => unknown }
  ? I
  : never;

/** One implementation, or one per member of a composition, with the members' names. */
export type OutputImplementations<P> = P extends OutputComposition
  ? { readonly [K in keyof P["members"]]: OutputImplementation<P["members"][K]> }
  : OutputImplementation<P>;

export type OutputBinding<P> =
  P extends Reader<infer F extends ReaderFunction>
    ? ReaderBinding<F>
    : P extends Writer<infer F extends WriterFunction>
      ? WriterBinding<F>
      : P extends Publisher<infer Message>
        ? PublisherBinding<Message>
        : P extends UnitOfWorkDefinition
          ? UnitOfWorkBinding
          : P extends Topic<infer _K, infer _M, infer _G> | Broadcast<infer _N, infer _H>
            ? SubscriptionBinding<P>
            : never;

export type OutputBindings<P> = P extends OutputComposition
  ? { readonly [K in keyof P["members"]]: OutputBinding<P["members"][K]> }
  : OutputBinding<P>;

export type FunctionOutputBinding = ReaderBinding | WriterBinding | PublisherBinding;

export type RuntimeOutputBinding = FunctionOutputBinding | SubscriptionBinding | UnitOfWorkBinding;

export function isOutputPort(value: unknown): value is OutputPort {
  return (
    isReader(value) ||
    isWriter(value) ||
    isPublisher(value) ||
    isSubscription(value) ||
    isUnitOfWork(value) ||
    isReaderComposition(value) ||
    isWriterComposition(value)
  );
}

export function normalizeOutputPorts(port: OutputPort): readonly OutputMember[] {
  return isReaderComposition(port) || isWriterComposition(port) ? Object.values(port.members) : [port];
}

export function bindingReference(binding: RuntimeOutputBinding): OutputMember {
  return isUnitOfWorkBinding(binding)
    ? binding.unitOfWork
    : isSubscriptionBinding(binding)
      ? binding.port
      : isReaderBinding(binding)
        ? binding.reader
        : isWriterBinding(binding)
          ? binding.writer
          : binding.publisher;
}

export function resolveOutputBinding(binding: FunctionOutputBinding): unknown {
  return isPublisherBinding(binding) ? resolvePublisher(binding) : binding.implementation;
}
