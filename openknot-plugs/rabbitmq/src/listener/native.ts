import type { EventEmitter } from "node:events";
import type { AsyncMessage, Connection, Consumer } from "rabbitmq-client";

/** Native decoded bodies remain untrusted until the application's decoder accepts them. */
export type RabbitDelivery = Omit<AsyncMessage, "body"> & { readonly body: unknown };
export type RabbitNativeConsumer = Pick<Consumer, "start" | "close"> & Pick<EventEmitter, "on" | "off">;
export type RabbitConsumerConnection = {
  createConsumer(...args: Parameters<Connection["createConsumer"]>): RabbitNativeConsumer;
};
