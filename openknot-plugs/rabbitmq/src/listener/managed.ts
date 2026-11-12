import type { RabbitResource, RabbitTopologyResource } from "../setup/topology.ts";
import { rabbitmqListener } from "./listener.ts";
import type { InputPortDefinition, InputResult, Listener } from "@openknot-ts/flow";
import { plug } from "@openknot-ts/wire";
import type { Plug, Requirements } from "@openknot-ts/wire";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ConsumerProps } from "rabbitmq-client";

export interface RabbitListenerConfig<Message> extends Omit<
  ConsumerProps,
  "queue" | "queueOptions" | "exchanges" | "queueBindings" | "exchangeBindings" | "lazy" | "noAck" | "requeue"
> {
  readonly queue: string;
  readonly schema?: StandardSchemaV1<unknown, Message>;
}

export type RabbitListenerBinding<
  I,
  R extends Requirements,
  O extends InputResult,
  C extends RabbitResource = RabbitResource,
> = Plug<Listener<I, R, O>, { readonly topology: RabbitTopologyResource<C> }>;

/** Internal binding constructor used by the topology-bound public API. */
export function bindRabbitListener<I, R extends Requirements, O extends InputResult, C extends RabbitResource>(
  topology: RabbitTopologyResource<C>,
  options: RabbitListenerConfig<NoInfer<I>>,
  port: Listener<I, R, O>,
): RabbitListenerBinding<I, R, O, C>;

export function bindRabbitListener(
  topology: RabbitTopologyResource,
  options: RabbitListenerConfig<unknown>,
  port: InputPortDefinition,
): Plug<InputPortDefinition, { readonly topology: RabbitTopologyResource }> {
  const { schema, ...consumerOptions } = options;

  return plug({
    port,
    requirements: { topology },
    bind: (context) => {
      const { declarations, connection, report } = context.topology;
      const queue = declarations.queues.find((entry) => entry.queue === options.queue);

      if (queue === undefined) {
        throw new TypeError(`Queue is not declared in this Rabbit topology: ${options.queue}`);
      }

      return rabbitmqListener(
        {
          connection,
          consumer: {
            ...consumerOptions,
            queueOptions: { ...queue },
            exchanges: [...declarations.exchanges],
            queueBindings: (declarations.queueBindings ?? []).filter((binding) => binding.queue === options.queue),
            exchangeBindings: [...(declarations.exchangeBindings ?? [])],
            qos: { prefetchCount: 8, ...consumerOptions.qos },
          },
          async decode({ body }) {
            const value: unknown = Buffer.isBuffer(body) ? JSON.parse(body.toString("utf8")) : body;

            if (schema === undefined) {
              return value;
            }

            const result = await schema["~standard"].validate(value);

            if (result.issues !== undefined) {
              throw new TypeError("Rabbit message failed schema validation", { cause: result.issues });
            }

            return result.value;
          },
          failurePolicy(failure) {
            // Flow logs every failure of an execution it ran; only a message it never received is reported here.
            if (failure.kind === "decode") {
              report(failure.error, {
                "messaging.destination.name": options.queue,
                ...(failure.delivery.messageId === undefined
                  ? {}
                  : { "messaging.message.id": failure.delivery.messageId }),
              });
            }
            return failure.kind === "post-commit" ? "ack" : "reject";
          },
          onError: report,
        },
        context,
      );
    },
  });
}
