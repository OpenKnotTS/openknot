import "@openknot-ts/flow/wire";
import { bindRabbitListener } from "./listener/managed.ts";
import type { RabbitListenerBinding, RabbitListenerConfig } from "./listener/managed.ts";
import { bindRabbitPublisher } from "./publisher/managed.ts";
import type { RabbitPublisherBinding, RabbitPublisherConfig } from "./publisher/managed.ts";
import { rabbit } from "./setup/connection.ts";
import type { RabbitExchange, RabbitExchangeBinding, RabbitQueue, RabbitQueueBinding } from "./setup/native.ts";
import { registerRabbitTopology } from "./setup/topology.ts";
import type { RabbitRoute, RabbitTopologyResource, RabbitResource } from "./setup/topology.ts";
import { rabbitConnectionOf } from "./setup/watch.ts";
import type { InputResult, Listener, Publisher } from "@openknot-ts/flow";
import type { HealthCheckDefinition } from "@openknot-ts/health";
import { healthCheck } from "@openknot-ts/health";
import type { ConnectionWatch, Provider, Requirements, ResolvedReferences } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";

type NamedQueue = RabbitQueue & { readonly queue: string };

type QueueBinding<E extends string, Q extends string> = Omit<RabbitQueueBinding, "exchange" | "queue"> & {
  readonly exchange: E;
  readonly queue: Q;
};

type ExchangeBinding<E extends string> = Omit<RabbitExchangeBinding, "source" | "destination"> & {
  readonly source: E;
  readonly destination: E;
};

type Route<E extends string, Q extends string> =
  | { readonly exchange: E; readonly routingKey: string }
  | { readonly exchange: ""; readonly routingKey: Q };

/** The topology's shared connection as the neutral `{ watch }` shape, for what must act when the broker is back. */
export type RabbitConnectionUnit<C extends RabbitResource = RabbitResource> = Provider<
  ConnectionWatch,
  ResolvedReferences<{ readonly topology: RabbitTopologyResource<C> }>,
  "unit",
  { readonly topology: RabbitTopologyResource<C> }
>;

export interface RabbitHealthOptions {
  readonly name?: string;
  readonly timeoutMs?: number;
}

export interface RabbitTopology<Q extends string, P extends RabbitRoute, C extends RabbitResource = typeof rabbit> {
  readonly rabbitNativeConnection: C;
  readonly rabbitConnection: RabbitConnectionUnit<C>;
  /** Up while the shared connection is ready; down from the moment it drops until it is restored. */
  rabbitHealthCheck(
    options?: RabbitHealthOptions,
  ): HealthCheckDefinition<{ readonly topology: RabbitTopologyResource<C> }>;
  rabbitListener<I, R extends Requirements, O extends InputResult>(
    config: (Omit<RabbitListenerConfig<NoInfer<I>>, "queue"> & { readonly queue: Q }) | undefined,
    port: Listener<I, R, O>,
  ): RabbitListenerBinding<I, R, O, C>;
  rabbitListener<I, R extends Requirements, O extends InputResult>(
    port: Listener<I, R, O>,
  ): RabbitListenerBinding<I, R, O, C>;
  rabbitPublisher<Message>(
    config: (P & Omit<RabbitPublisherConfig<NoInfer<Message>>, keyof RabbitRoute>) | undefined,
    port: Publisher<Message>,
  ): RabbitPublisherBinding<Message, C>;
  rabbitPublisher<Message>(port: Publisher<Message>): RabbitPublisherBinding<Message, C>;
}

export function rabbitTopology<
  const E extends readonly RabbitExchange[],
  const Q extends readonly NamedQueue[],
  const P extends readonly RabbitRoute[],
  const C extends RabbitResource = typeof rabbit,
>(options: {
  readonly exchanges: E;
  readonly queues: Q;
  readonly routes: P & readonly Route<NoInfer<E[number]["exchange"]>, NoInfer<Q[number]["queue"]>>[];
  readonly queueBindings?: readonly QueueBinding<NoInfer<E[number]["exchange"]>, NoInfer<Q[number]["queue"]>>[];
  readonly exchangeBindings?: readonly ExchangeBinding<NoInfer<E[number]["exchange"]>>[];
  readonly connection?: C;
}): RabbitTopology<Q[number]["queue"], P[number], C> {
  const declarations = {
    exchanges: options.exchanges.map((entry) => ({ durable: true, ...entry })),
    queues: options.queues.map((entry) => ({ durable: true, ...entry })),
    routes: options.routes.map((entry) => ({ ...entry })),
    queueBindings: (options.queueBindings ?? []).map((entry) => ({ ...entry })),
    exchangeBindings: (options.exchangeBindings ?? []).map((entry) => ({ ...entry })),
  };

  const exchanges = new Set(declarations.exchanges.map((entry) => entry.exchange));
  const queues = new Set(declarations.queues.map((entry) => entry.queue));

  if (
    exchanges.size !== declarations.exchanges.length ||
    queues.size !== declarations.queues.length ||
    exchanges.has("") ||
    [...exchanges, ...queues].some((name) => name.length === 0)
  ) {
    throw new TypeError("Rabbit topology requires distinct nonempty exchange and queue names");
  }

  for (const route of declarations.routes) {
    if (route.exchange === "" ? !queues.has(route.routingKey) : !exchanges.has(route.exchange)) {
      throw new TypeError("Rabbit route references an undeclared exchange or default-exchange queue");
    }
  }

  for (const binding of declarations.queueBindings) {
    if (!exchanges.has(binding.exchange) || !queues.has(binding.queue)) {
      throw new TypeError("Rabbit queue binding references an undeclared exchange or queue");
    }
  }

  for (const binding of declarations.exchangeBindings) {
    if (!exchanges.has(binding.source) || !exchanges.has(binding.destination)) {
      throw new TypeError("Rabbit exchange binding references an undeclared exchange");
    }
  }

  const native = (options.connection ?? rabbit) as C;
  const topology = registerRabbitTopology(declarations, native);

  // Public overloads retain each port's inferred input/output and the topology's literal routes.
  const rabbitListener: RabbitTopology<Q[number]["queue"], P[number], C>["rabbitListener"] = function <
    I,
    R extends Requirements,
    O extends InputResult,
  >(
    ...args:
      | [Listener<I, R, O>]
      | [
          (Omit<RabbitListenerConfig<NoInfer<I>>, "queue"> & { readonly queue: Q[number]["queue"] }) | undefined,
          Listener<I, R, O>,
        ]
  ) {
    const port = args.length === 1 ? args[0] : args[1];
    const config = args.length === 1 ? undefined : args[0];
    const queue = config?.queue ?? (declarations.queues.length === 1 ? declarations.queues[0]?.queue : undefined);

    if (queue === undefined || !queues.has(queue)) {
      throw new TypeError("Select a declared Rabbit queue when the topology has multiple queues");
    }

    return bindRabbitListener(topology, { ...config, queue }, port);
  };

  const rabbitPublisher: RabbitTopology<Q[number]["queue"], P[number], C>["rabbitPublisher"] = function <Message>(
    ...args:
      | [Publisher<Message>]
      | [(P[number] & Omit<RabbitPublisherConfig<NoInfer<Message>>, keyof RabbitRoute>) | undefined, Publisher<Message>]
  ) {
    const port = args.length === 1 ? args[0] : args[1];
    const config = args.length === 1 ? undefined : args[0];
    const route = config ?? (declarations.routes.length === 1 ? declarations.routes[0] : undefined);

    if (
      route === undefined ||
      !declarations.routes.some((entry) => entry.exchange === route.exchange && entry.routingKey === route.routingKey)
    ) {
      throw new TypeError("Select a declared Rabbit publish route when the topology has multiple routes");
    }

    return bindRabbitPublisher(topology, route, port);
  };

  const rabbitConnection: RabbitConnectionUnit<C> = unit({
    requirements: { topology },
    factory: ({ topology }) => rabbitConnectionOf(topology.connection),
  });

  const rabbitHealthCheck: RabbitTopology<Q[number]["queue"], P[number], C>["rabbitHealthCheck"] = (
    healthOptions = {},
  ) =>
    healthCheck({
      name: healthOptions.name ?? "rabbitmq",
      requirements: { topology },
      ...(healthOptions.timeoutMs === undefined ? {} : { timeoutMs: healthOptions.timeoutMs }),
      check: async ({ topology }) => (topology.connection.ready ? "up" : "down"),
    });

  return Object.freeze({
    rabbitNativeConnection: native,
    rabbitConnection,
    rabbitHealthCheck,
    rabbitListener,
    rabbitPublisher,
  });
}

export type { RabbitListenerBinding, RabbitListenerConfig } from "./listener/managed.ts";
export type { RabbitConsumerConnection, RabbitDelivery, RabbitNativeConsumer } from "./listener/native.ts";
export type { RabbitPublisherBinding, RabbitPublisherConfig } from "./publisher/managed.ts";
export type { RabbitEnvelope, RabbitNativePublisher, RabbitPublisherConnection } from "./publisher/native.ts";
export { rabbit, rabbitClient, rabbitErrors } from "./setup/connection.ts";
export { rabbitConnectionOf } from "./setup/watch.ts";
