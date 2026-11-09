import type { RabbitConsumerConnection, RabbitDelivery, RabbitNativeConsumer } from "../src/index.ts";
import { EventEmitter } from "node:events";

type Status = 0 | 1 | 2;
type ConsumerOptions = Parameters<RabbitConsumerConnection["createConsumer"]>[0];
type Handler = Parameters<RabbitConsumerConnection["createConsumer"]>[1];

export interface FakeConsumer extends RabbitNativeConsumer {
  readonly received: Promise<Status>[];
  readonly statuses: number[];
  startupError: unknown;
  autoReady: boolean;
  closed: number;
  stopping: boolean;
  deliver(message?: Partial<RabbitDelivery>): Promise<Status>;
  emit(event: string | symbol, ...args: unknown[]): boolean;
  listenerCount(event: string | symbol): number;
}
export function fakeConsumer(handler: Handler): FakeConsumer {
  const consumer: FakeConsumer = Object.assign(new EventEmitter(), {
    received: [],
    statuses: [],
    startupError: undefined,
    autoReady: true,
    closed: 0,
    stopping: false,
    start(): void {
      if (consumer.autoReady) {
        queueMicrotask(() =>
          consumer.emit(consumer.startupError === undefined ? "ready" : "error", consumer.startupError),
        );
      }
    },
    deliver(message: Partial<RabbitDelivery> = {}): Promise<Status> {
      if (consumer.stopping) {
        throw new Error("Consumer stopped");
      }
      const work = Promise.resolve(
        handler(
          {
            body: Buffer.from("1"),
            consumerTag: "test",
            exchange: "events",
            routingKey: "changed",
            deliveryTag: 1,
            redelivered: false,
            ...message,
          },
          async () => {
            throw new Error("The listener adapter does not issue RPC replies");
          },
        ),
      ).then((status) => status ?? 0);
      consumer.received.push(work);
      void work.then((status) => {
        consumer.statuses.push(status);
      });
      return work;
    },
    async close(): Promise<void> {
      consumer.closed++;
      consumer.stopping = true;
      await Promise.allSettled(consumer.received);
    },
  });
  return consumer;
}

export interface FakeConsumerConnection extends RabbitConsumerConnection {
  consumer: FakeConsumer | undefined;
  options: ConsumerOptions | undefined;
  setup: ((consumer: FakeConsumer) => void) | undefined;
}
export function fakeConsumerConnection(): FakeConsumerConnection {
  const connection: FakeConsumerConnection = {
    consumer: undefined,
    options: undefined,
    setup: undefined,
    createConsumer(options, handler) {
      connection.options = options;
      connection.consumer = fakeConsumer(handler);
      connection.setup?.(connection.consumer);
      return connection.consumer;
    },
  };
  return connection;
}
