import { messagingAttributes } from "../setup/native.ts";
import { deliveryPropagation, deliveryTrigger } from "./metadata.ts";
import type { RabbitConsumerConnection, RabbitDelivery } from "./native.ts";
import { InputCancelledError, InputUnavailableError, PostCommitError } from "@openknot-ts/flow";
import type { ExecutionInvoker, ListenerRequest } from "@openknot-ts/flow";
import { propagationFields } from "@openknot-ts/tracing";
import type { PlugHandle } from "@openknot-ts/wire";
import { ConsumerStatus } from "rabbitmq-client";
import type { ConsumerProps } from "rabbitmq-client";

export type RabbitFailureKind = "decode" | "handler" | "cancelled" | "post-commit";

export interface RabbitFailure<Message> {
  readonly kind: RabbitFailureKind;
  readonly error: unknown;
  readonly delivery: RabbitDelivery;
  readonly input?: Message;
}

/** Reject uses the broker's dead-letter policy. Retry routing/budgets belong to that topology. */
export type RabbitFailureAction = "ack" | "reject";

export interface RabbitListenerOptions<Message> {
  readonly connection: RabbitConsumerConnection;
  readonly consumer: Omit<ConsumerProps, "lazy" | "noAck" | "requeue">;
  readonly decode: (delivery: RabbitDelivery) => Message | PromiseLike<Message>;
  readonly failurePolicy: (failure: RabbitFailure<Message>) => RabbitFailureAction | PromiseLike<RabbitFailureAction>;
  readonly onError: (error: unknown) => void;
}

function classify(error: unknown): Exclude<RabbitFailureKind, "decode"> {
  if (PostCommitError.is(error)) {
    return "post-commit";
  }
  if (InputCancelledError.is(error)) {
    return "cancelled";
  }
  return "handler";
}

/** Native consumer startup/cleanup for an ordinary Wire input plug. */
export async function rabbitmqListener<Message>(
  options: RabbitListenerOptions<Message>,
  {
    invoke,
    signal,
  }: {
    readonly invoke: ExecutionInvoker<ListenerRequest<Message>, unknown>;
    readonly signal: AbortSignal;
  },
): Promise<PlugHandle> {
  const { connection, consumer: consumerOptions, decode, failurePolicy, onError } = options;

  signal.throwIfAborted();

  async function failed(failure: RabbitFailure<Message>): Promise<ConsumerStatus> {
    try {
      const action = await failurePolicy(failure);

      if (action === "ack") {
        return ConsumerStatus.ACK;
      }

      if (action === "reject") {
        return ConsumerStatus.DROP;
      }

      throw new TypeError("Failure policy must return ack or reject");
    } catch (error) {
      onError(error);
      return ConsumerStatus.DROP;
    }
  }

  const consumer = connection.createConsumer(
    {
      ...consumerOptions,
      lazy: true,
      noAck: false,
      requeue: false,
    },
    async (delivery) => {
      let input: Message;

      try {
        input = await decode(delivery);
      } catch (error) {
        return failed({ kind: "decode", error, delivery });
      }

      try {
        // Source lifetime stops intake. Admitted work has its own Flow execution lifetime.
        await invoke({
          input,
          propagation: deliveryPropagation(delivery, propagationFields(invoke.tracing)),
          traceAttributes: messagingAttributes(
            "process",
            delivery.exchange,
            delivery.routingKey,
            delivery.messageId,
            consumerOptions.queue,
            delivery.correlationId,
          ),
          trigger: deliveryTrigger(delivery),
        });

        return ConsumerStatus.ACK;
      } catch (error) {
        // An input that no longer admits work, as once intake stops, processed nothing: the queue keeps the delivery.
        if (InputUnavailableError.is(error)) {
          return ConsumerStatus.REQUEUE;
        }
        // A failed execution rejects with its classified error; the failure policy chooses ack or reject.
        return failed({ kind: classify(error), error, delivery, input });
      }
    },
  );

  let releasing: Promise<void> | undefined;
  let starting = true;
  const ready = Promise.withResolvers<void>();

  const onReady = () => {
    starting = false;
    ready.resolve();
  };

  const onConsumerError = (error: unknown) => {
    if (starting) {
      ready.reject(error);
    } else {
      onError(error);
    }
  };

  const release = (): Promise<void> => {
    if (releasing === undefined) {
      signal.removeEventListener("abort", onAbort);
      releasing = consumer.close();
    }
    return releasing;
  };

  const onAbort = () => {
    ready.reject(signal.reason);
    void release().catch(onError);
  };

  consumer.on("ready", onReady);
  consumer.on("error", onConsumerError);

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    consumer.start();

    if (signal.aborted) {
      onAbort();
    }

    await ready.promise;
    signal.throwIfAborted();

    return { release };
  } catch (error) {
    try {
      await release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "RabbitMQ consumer startup and cleanup failed");
    }

    throw error;
  } finally {
    consumer.off("ready", onReady);
  }
}
