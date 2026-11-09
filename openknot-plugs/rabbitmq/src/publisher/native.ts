import type { Connection, Envelope, Publisher } from "rabbitmq-client";

export type RabbitEnvelope = Envelope;
export type RabbitNativePublisher = Publisher;
export type RabbitPublisherConnection = Pick<
  Connection,
  "queueDeclare" | "exchangeDeclare" | "queueBind" | "exchangeBind" | "createPublisher"
>;
