import type { RabbitErrors } from "./connection.ts";
import { rabbitErrors } from "./connection.ts";
import type { RabbitExchange, RabbitExchangeBinding, RabbitQueue, RabbitQueueBinding } from "./native.ts";
import { resource } from "@openknot-ts/wire";
import type { ManagedResource, Provider, ResolvedReferences } from "@openknot-ts/wire";
import type { Connection } from "rabbitmq-client";

export interface RabbitRoute {
  readonly exchange: string;
  readonly routingKey: string;
}

export interface RabbitDeclarations {
  readonly exchanges: readonly RabbitExchange[];
  readonly queues: readonly (RabbitQueue & { readonly queue: string })[];
  readonly routes: readonly RabbitRoute[];
  readonly queueBindings?: readonly RabbitQueueBinding[];
  readonly exchangeBindings?: readonly RabbitExchangeBinding[];
}

export interface RegisteredRabbitTopology {
  readonly connection: Connection;
  readonly declarations: RabbitDeclarations;
  /** Hands a failure no caller receives to `rabbitErrors`. */
  readonly report: RabbitErrors;
}

export type RabbitResource = Provider<ManagedResource<Connection>, never, "resource">;
type TopologyRequirements<C extends RabbitResource> = {
  readonly rabbit: C;
  readonly report: typeof rabbitErrors;
};

export type RabbitTopologyResource<C extends RabbitResource = RabbitResource> = Provider<
  ManagedResource<RegisteredRabbitTopology>,
  ResolvedReferences<TopologyRequirements<C>>,
  "resource",
  TopologyRequirements<C>
>;

/** Resource identity binds registration and cleanup to the topology's consumers. */
export function registerRabbitTopology<C extends RabbitResource>(
  declarations: RabbitDeclarations,
  connection: C,
): RabbitTopologyResource<C> {
  return resource({
    requirements: { rabbit: connection, report: rabbitErrors },
    async initialize(dependencies, { signal }) {
      const rabbit = dependencies.rabbit as Connection;
      const fail = dependencies.report;
      let closing = false;
      async function declare() {
        const channel = await rabbit.acquire();
        const abort = () => {
          void channel.close().catch(fail);
        };

        signal.addEventListener("abort", abort, { once: true });

        try {
          signal.throwIfAborted();

          for (const exchange of declarations.exchanges) {
            await channel.exchangeDeclare(exchange);
          }

          for (const queue of declarations.queues) {
            await channel.queueDeclare(queue);
          }

          for (const binding of declarations.exchangeBindings ?? []) {
            await channel.exchangeBind(binding);
          }

          for (const binding of declarations.queueBindings ?? []) {
            await channel.queueBind(binding);
          }

          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", abort);
          await channel.close();
        }
      }

      let pending = Promise.resolve();

      const recover = () => {
        if (!closing) {
          pending = pending.then(declare, declare);
          void pending.catch(fail);
        }
      };

      rabbit.on("connection", recover);

      try {
        await declare();
      } catch (error) {
        closing = true;
        rabbit.off("connection", recover);
        await Promise.allSettled([pending]);
        throw error;
      }

      return {
        value: { connection: rabbit, declarations, report: dependencies.report },
        async release() {
          closing = true;
          rabbit.off("connection", recover);
          await Promise.allSettled([pending]);
        },
      };
    },
  });
}
