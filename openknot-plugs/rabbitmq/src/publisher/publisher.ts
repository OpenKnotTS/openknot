import type { RabbitProperties, RabbitQueue, RabbitTopology } from "../setup/native.ts";
import { messagingAttributes } from "../setup/native.ts";
import type { RabbitPublisherConnection } from "./native.ts";
import type { PublishOptions } from "@openknot-ts/flow";
import { capturePropagation, propagationFields, withTrace } from "@openknot-ts/tracing";
import type { ResourceHandle } from "@openknot-ts/wire";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Publisher, PublisherProps, ReturnedMessage } from "rabbitmq-client";

export interface RabbitPublisher<Message> {
  readonly native: Publisher;
  publish(message: Message, options?: PublishOptions): Promise<void>;
}

export interface RabbitPublisherOptions<Message> {
  readonly connection: RabbitPublisherConnection;
  readonly exchange: string;
  readonly routingKey: string | ((message: Message) => string);
  readonly encode: (message: Message) => Buffer;
  readonly properties?: (message: Message, options: PublishOptions) => RabbitProperties;
  /** Declared while the resource initializes; the native publisher declares it again on each new channel. */
  readonly topology?: RabbitTopology & { queues?: RabbitQueue[] };
  /** Native send attempts. Defaults to one; retries can duplicate a publication. */
  readonly maxAttempts?: number;
  readonly publisher?: Omit<PublisherProps, keyof RabbitTopology | "queues" | "confirm">;
  readonly configure?: (publisher: Publisher) => void;
  readonly mandatory?: boolean;
  /** The initializer's signal: aborting stops waiting for the topology, for instance while the broker is down. */
  readonly signal: AbortSignal;
}

/** Settles with the native work, or rejects once the signal aborts; the work itself cannot be cancelled. */
async function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener("abort", abort));
}

/**
 * Declares the topology on the connection, in the order the native publisher repeats it, so a conflicting
 * declaration fails startup instead of the first publication. Routing is a property of this topology:
 * messages no binding accepts reach the exchange's `alternate-exchange` when one is declared.
 */
async function declareTopology(
  connection: RabbitPublisherConnection,
  topology: RabbitTopology & { queues?: RabbitQueue[] },
  signal: AbortSignal,
): Promise<void> {
  const declarations = [
    ...(topology.queues ?? []).map((queue) => () => connection.queueDeclare(queue)),
    ...(topology.exchanges ?? []).map((exchange) => () => connection.exchangeDeclare(exchange)),
    ...(topology.queueBindings ?? []).map((binding) => () => connection.queueBind(binding)),
    ...(topology.exchangeBindings ?? []).map((binding) => () => connection.exchangeBind(binding)),
  ];

  for (const declare of declarations) {
    signal.throwIfAborted();
    await until<unknown>(declare(), signal);
  }
}

/** A Wire resource initializer: closes its native publisher, never the supplied connection. */
export function rabbitmqPublisher<Message>(
  options: RabbitPublisherOptions<Message>,
): Promise<ResourceHandle<RabbitPublisher<Message>>> {
  const { connection, exchange, routingKey, encode, properties, topology, signal } = options;
  const maxAttempts = options.publisher?.maxAttempts ?? options.maxAttempts ?? 1;

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("Publisher maxAttempts must be a positive safe integer");
  }

  async function open(): Promise<ResourceHandle<RabbitPublisher<Message>>> {
    signal.throwIfAborted();

    if (topology !== undefined) {
      await declareTopology(connection, topology, signal);
    }

    const publisher = connection.createPublisher({ ...topology, ...options.publisher, confirm: true, maxAttempts });
    const returned = new Map<string, ReturnedMessage>();

    publisher.on("basic.return", (message) => {
      if (message.messageId !== undefined) {
        returned.set(message.messageId, message);
      }
    });
    try {
      options.configure?.(publisher);
    } catch (error) {
      await publisher.close();
      throw error;
    }

    const active = new Set<Promise<void>>();
    let closing = false;
    let release: Promise<void> | undefined;

    async function send(message: Message, execution: PublishOptions): Promise<void> {
      const tracing = execution.tracing;

      execution.signal?.throwIfAborted();

      const supplied = properties?.(message, execution) ?? {};
      const headers = { ...supplied.headers };

      if (tracing !== undefined || execution.propagation !== undefined) {
        const fields = new Set(propagationFields(tracing).map((key) => key.toLowerCase()));
        for (const key of Object.keys(headers)) {
          if (fields.has(key.toLowerCase())) {
            delete headers[key];
          }
        }
      }

      const key = typeof routingKey === "string" ? routingKey : routingKey(message);
      const messageId = supplied.messageId ?? randomUUID();
      const attributes = messagingAttributes("send", exchange, key, messageId, undefined, supplied.correlationId);

      await withTrace(
        tracing,
        {
          name: `send ${attributes["messaging.destination.name"]}`,
          kind: "producer",
          reference: options,
          propagation: execution.propagation,
          attributes,
        },
        async () => {
          const propagation = capturePropagation(tracing) ?? execution.propagation;
          // The confirm settles the send: the broker took the message, and its topology decides where it goes.
          try {
            await publisher.send(
              {
                ...supplied,
                messageId,
                headers: { ...headers, ...propagation },
                exchange,
                routingKey: key,
                ...(options.mandatory === undefined ? {} : { mandatory: options.mandatory }),
              },
              encode(message),
            );
            if (options.mandatory === true) {
              // The SDK dispatches basic.return with setImmediate, after resolving the native confirm.
              await setImmediate();
            }
            const rejection = returned.get(messageId);
            if (rejection !== undefined) {
              throw new Error("RabbitMQ publication was unroutable", { cause: rejection });
            }
          } finally {
            returned.delete(messageId);
          }
        },
      );
    }
    return {
      value: Object.freeze({
        native: publisher,
        async publish(message: Message, execution: PublishOptions = {}): Promise<void> {
          if (closing) {
            throw new Error("RabbitMQ publisher is closing");
          }

          const work = send(message, execution);

          active.add(work);

          try {
            await work;
          } finally {
            active.delete(work);
          }
        },
      }),
      release(): Promise<void> {
        return (release ??= (async () => {
          closing = true;
          await Promise.allSettled(active);
          await publisher.close();
        })());
      },
    };
  }
  return open();
}
