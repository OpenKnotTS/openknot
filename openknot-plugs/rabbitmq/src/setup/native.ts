import type { TraceAttributes } from "@openknot-ts/tracing";
import type { HeaderFields, PublisherProps } from "rabbitmq-client";

export type RabbitProperties = HeaderFields;
export type RabbitQueue = NonNullable<PublisherProps["queues"]>[number];
export type RabbitExchange = NonNullable<PublisherProps["exchanges"]>[number];
export type RabbitQueueBinding = NonNullable<PublisherProps["queueBindings"]>[number];
export type RabbitExchangeBinding = NonNullable<PublisherProps["exchangeBindings"]>[number];
export type RabbitTopology = Pick<PublisherProps, "exchanges" | "queueBindings" | "exchangeBindings">;

/** Standard messaging trace attributes for a send or a processed delivery. */
export function messagingAttributes(
  operation: "send" | "process",
  exchange: string,
  routingKey: string,
  messageId?: string,
  queue?: string,
  correlationId?: string,
): TraceAttributes {
  const destination =
    [exchange, routingKey, queue === routingKey ? "" : queue].filter(Boolean).join(":") || "amq.default";
  return {
    "messaging.system": "rabbitmq",
    "messaging.destination.name": destination,
    "messaging.operation.name": operation,
    "messaging.operation.type": operation,
    ...(routingKey.length === 0 ? {} : { "messaging.rabbitmq.destination.routing_key": routingKey }),
    ...(messageId === undefined ? {} : { "messaging.message.id": messageId }),
    ...(correlationId === undefined ? {} : { "messaging.message.conversation_id": correlationId }),
  };
}
