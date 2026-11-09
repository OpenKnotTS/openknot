import type { RabbitResource, RabbitRoute, RabbitTopologyResource } from "../setup/topology.ts";
import { rabbitmqPublisher } from "./publisher.ts";
import type { RabbitPublisher } from "./publisher.ts";
import type { Publisher, PublishOptions } from "@openknot-ts/flow";
import { plug, resource } from "@openknot-ts/wire";
import type { ManagedResource, Plug, Provider, ResolvedReferences } from "@openknot-ts/wire";
import type { HeaderFields, PublisherProps, Publisher as NativePublisher } from "rabbitmq-client";

export interface RabbitPublisherConfig<Message = unknown> extends RabbitRoute {
  readonly properties?: HeaderFields | ((message: Message, options: PublishOptions) => HeaderFields);
  readonly publisher?: Omit<PublisherProps, "confirm" | "exchanges" | "queues" | "queueBindings" | "exchangeBindings">;
  readonly configure?: (publisher: NativePublisher) => void;
}

type Sending<Message, C extends RabbitResource> = Provider<
  ManagedResource<RabbitPublisher<Message>>,
  ResolvedReferences<{ readonly topology: RabbitTopologyResource<C> }>,
  "resource",
  { readonly topology: RabbitTopologyResource<C> }
>;
export type RabbitPublisherBinding<Message, C extends RabbitResource = RabbitResource> = Plug<
  Publisher<Message>,
  { readonly sending: Sending<Message, C> }
>;

/** Internal binding constructor used by the topology-bound public API. */
export function bindRabbitPublisher<Message, C extends RabbitResource>(
  topology: RabbitTopologyResource<C>,
  options: RabbitPublisherConfig<Message>,
  port: Publisher<Message>,
): RabbitPublisherBinding<Message, C> {
  const sending = resource({
    requirements: { topology },
    initialize({ topology }, { signal }) {
      const { connection, declarations } = topology;
      if (
        !declarations.routes.some(
          (route) => route.exchange === options.exchange && route.routingKey === options.routingKey,
        )
      ) {
        throw new TypeError("Publication route is not declared in this Rabbit topology");
      }
      return rabbitmqPublisher<Message>({
        connection,
        exchange: options.exchange,
        routingKey: options.routingKey,
        topology: {
          exchanges: [...declarations.exchanges],
          queues: [...declarations.queues],
          queueBindings: [...(declarations.queueBindings ?? [])],
          exchangeBindings: [...(declarations.exchangeBindings ?? [])],
        },
        encode(message) {
          const json = JSON.stringify(message);
          if (json === undefined) {
            throw new TypeError("Rabbit publications must be JSON values");
          }
          return Buffer.from(json);
        },
        properties: (message, execution) => ({
          durable: true,
          ...(typeof options.properties === "function" ? options.properties(message, execution) : options.properties),
          ...(execution.messageId === undefined ? {} : { messageId: execution.messageId }),
          contentType: "application/json",
        }),
        mandatory: true,
        ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
        ...(options.configure === undefined ? {} : { configure: options.configure }),
        signal,
      });
    },
  });
  return plug({ port, requirements: { sending }, bind: ({ sending }) => sending.publish });
}
