import type { RabbitEnvelope, RabbitNativePublisher, RabbitPublisherConnection } from "../src/index.ts";
import { EventEmitter } from "node:events";

type PublisherOptions = Parameters<RabbitPublisherConnection["createPublisher"]>[0];

export interface FakePublisher extends RabbitNativePublisher {
  readonly sent: { envelope: RabbitEnvelope; body: Buffer; confirm: ReturnType<typeof Promise.withResolvers<void>> }[];
  closed: number;
}
export function fakePublisher(): FakePublisher {
  const publisher: FakePublisher = Object.assign(new EventEmitter(), {
    sent: [],
    closed: 0,
    async send(envelope: RabbitEnvelope | string, body: unknown): Promise<void> {
      if (!Buffer.isBuffer(body)) {
        throw new TypeError("The adapter must publish encoded bytes");
      }
      const confirm = Promise.withResolvers<void>();
      publisher.sent.push({
        envelope: typeof envelope === "string" ? { routingKey: envelope } : envelope,
        body,
        confirm,
      });
      await confirm.promise;
    },
    async close(): Promise<void> {
      publisher.closed++;
    },
  });
  return publisher;
}

export interface FakePublisherConnection extends RabbitPublisherConnection {
  readonly publisher: FakePublisher;
  readonly declared: string[];
  /** Every declaration settles with it: a rejection is a broker refusal, a pending one an unreachable broker. */
  declaration: Promise<void>;
  options: PublisherOptions | undefined;
}
export function fakePublisherConnection(): FakePublisherConnection {
  const connection: FakePublisherConnection = {
    publisher: fakePublisher(),
    declared: [],
    declaration: Promise.resolve(),
    options: undefined,
    async queueDeclare(options = {}) {
      const queue = typeof options === "string" ? options : options.queue;
      connection.declared.push(`queue ${queue}`);
      await connection.declaration;
      return { queue: queue ?? "", messageCount: 0, consumerCount: 0 };
    },
    async exchangeDeclare({ exchange }) {
      connection.declared.push(`exchange ${exchange}`);
      await connection.declaration;
    },
    async queueBind({ exchange, queue }) {
      connection.declared.push(`bind ${exchange} → ${queue}`);
      await connection.declaration;
    },
    async exchangeBind({ source, destination }) {
      connection.declared.push(`bind ${source} → ${destination}`);
      await connection.declaration;
    },
    createPublisher(options) {
      connection.options = options;
      return connection.publisher;
    },
  };
  return connection;
}
