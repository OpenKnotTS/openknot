import { success } from "@openknot-ts/behavior";
import { drizzleOutbox } from "@openknot-ts/drizzle-outbox/pg";
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import type { Publish } from "@openknot-ts/flow";
import { command, defaultUnitOfWork, expose, listener, publisher, writer } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { health } from "@openknot-ts/health";
import { http } from "@openknot-ts/knot-http-node";
import { restRoutes } from "@openknot-ts/knot-rest";
import { restNodeHttp } from "@openknot-ts/knot-rest-http-node";
import { outbox, outboxControl } from "@openknot-ts/outbox";
import { postgresClient, postgresHealthCheck } from "@openknot-ts/postgres-client";
import { rabbitTopology } from "@openknot-ts/rabbitmq";
import { config, defineApplication, plug, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";

// A small order service over real PostgreSQL and RabbitMQ whose order events leave through the outbox, shared by the
// opt-in outbox suite and the process its crash scenario kills.
export const { DATABASE_URL, RABBITMQ_URL } = process.env;
export const skip =
  DATABASE_URL === undefined || RABBITMQ_URL === undefined
    ? "set DATABASE_URL and RABBITMQ_URL to run against real services"
    : false;
export const run = process.env.E2E_RUN ?? randomUUID().slice(0, 8);

export interface OrderPlaced {
  readonly type: "order-placed";
  readonly id: string;
  readonly name: string;
}

/** What the outbox handed to RabbitMQ, and how the send ended. */
export interface Attempt {
  readonly messageId: string;
  readonly order: string;
  readonly outcome: "sent" | "failed" | "held";
}

/** What a RabbitMQ listener received. */
export interface Delivery {
  readonly messageId: string | undefined;
  readonly order: string;
}

/** Collected items and a change event, so a test waits for exactly the state it needs, within its deadline. */
export function recorder<T>() {
  const items: T[] = [];
  const changed = new EventTarget();
  return {
    items,
    push(item: T) {
      items.push(item);
      changed.dispatchEvent(new Event("change"));
    },
    until(condition: (items: readonly T[]) => boolean, signal: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (condition(items)) {
            stop();
            resolve();
          }
        };
        const abort = () => {
          stop();
          reject(signal.reason);
        };
        const stop = () => {
          changed.removeEventListener("change", check);
          signal.removeEventListener("abort", abort);
        };
        changed.addEventListener("change", check);
        signal.addEventListener("abort", abort, { once: true });
        check();
      });
    },
  };
}
export type Recorder<T> = ReturnType<typeof recorder<T>>;

async function withClient<T>(work: (client: pg.Client) => Promise<T>, schema?: string): Promise<T> {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function createSchema(schema: string): Promise<void> {
  await withClient((client) =>
    client.query(`
      CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.orders (id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE ${schema}.openknot_outbox (sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id text NOT NULL UNIQUE, name text NOT NULL, message text NOT NULL, propagation text,
        attempts integer NOT NULL DEFAULT 0, error text, claimed_by text, claimed_until bigint);`),
  );
}

export async function dropSchema(schema: string): Promise<void> {
  await withClient((client) => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
}

export async function rows(schema: string, query: string): Promise<readonly Record<string, unknown>[]> {
  return withClient(async (client) => (await client.query(query)).rows, schema);
}

const orders = pgTable("orders", { id: text().primaryKey(), name: text().notNull() });
const exchange = `openknot-outbox-e2e-${run}`;
const queue = `${exchange}.orders`;
const { rabbitConnection, rabbitHealthCheck, rabbitListener, rabbitPublisher } = rabbitTopology({
  exchanges: [{ exchange, type: "topic", autoDelete: true }],
  queues: [{ queue, arguments: { "x-expires": 60_000 } }],
  routes: [{ exchange, routingKey: "order.placed" }],
  queueBindings: [{ exchange, queue, routingKey: "order.placed" }],
});

const settings = config({
  DATABASE_URL: (value: string | undefined) => value ?? "",
  E2E_SCHEMA: (value: string | undefined) => value ?? "",
});

export interface OutboxApplicationOptions {
  readonly schema: string;
  readonly attempts: Recorder<Attempt>;
  readonly deliveries: Recorder<Delivery>;
  readonly leaseMs?: number;
  /** Holds every send forever, as a process that is killed while sending. */
  readonly hold?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export function outboxApplication(options: OutboxApplicationOptions) {
  const { attempts, deliveries, hold = false } = options;
  const postgres = postgresClient({
    requirements: { settings },
    create: ({ settings }) =>
      new pg.Pool({
        connectionString: settings.DATABASE_URL,
        options: `-c search_path=${settings.E2E_SCHEMA}`,
        connectionTimeoutMillis: 2_000,
        query_timeout: 5_000,
      }).on("error", () => undefined),
  });
  const transaction = unit({
    requirements: { postgres },
    factory: ({ postgres }) => drizzleUnitOfWork({ database: drizzle({ client: postgres }) }),
  });

  const orderEvents = publisher<OrderPlaced>();
  const saveOrder = writer<(order: { readonly id: string; readonly name: string }) => Promise<void>>();
  const placeOrder = expose({
    handler: command<{ readonly id: string; readonly name: string }, { readonly id: string }>()({
      requirements: { saveOrder, orderEvents },
      run: async (order, ctx) => {
        await ctx.saveOrder(order);
        await ctx.orderEvents.publish({ type: "order-placed", ...order });
        return success({ id: order.id });
      },
    }),
  });
  const orderPlaced = listener<OrderPlaced>()({
    run: (event, ctx) => {
      deliveries.push({ messageId: ctx.trigger.messageId, order: event.id });
      return success();
    },
  });

  const rabbit = rabbitPublisher({ exchange, routingKey: "order.placed" }, orderEvents);
  // The native publisher, observed: every send the outbox makes, and how it ended.
  const observed = plug({
    port: orderEvents,
    requirements: rabbit.requirements,
    bind: (dependencies) => {
      const send = (rabbit.bind as (context: typeof dependencies) => Publish<OrderPlaced>)(dependencies);
      return async (event, publishOptions) => {
        const messageId = publishOptions.messageId!;
        if (hold) {
          attempts.push({ messageId, order: event.id, outcome: "held" });
          await new Promise(() => undefined);
        }
        try {
          await send(event, publishOptions);
        } catch (error) {
          attempts.push({ messageId, order: event.id, outcome: "failed" });
          throw error;
        }
        attempts.push({ messageId, order: event.id, outcome: "sent" });
      };
    },
  });

  return runApplication(
    defineApplication({
      modules: [
        http,
        restNodeHttp,
        health,
        provideFlow([placeOrder, orderPlaced]),
        providePlugs([
          postgres,
          postgresHealthCheck({ postgres }),
          rabbitHealthCheck(),
          transaction,
          plug({ port: defaultUnitOfWork, requirements: { transaction }, bind: ({ transaction }) => transaction }),
          plug({
            port: saveOrder,
            requirements: { transaction },
            bind:
              ({ transaction }) =>
              async (order) => {
                await (await transaction.current()).insert(orders).values(order);
              },
          }),
          outbox({ name: "orders", plug: observed, connection: rabbitConnection }),
          drizzleOutbox({ transaction, ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }) }),
          outboxControl,
          rabbitListener({ queue }, orderPlaced),
          restRoutes({
            port: placeOrder,
            routes: { post: "/orders", input: z.object({ id: z.string(), name: z.string() }), status: 201 },
          }),
        ]),
      ],
    }),
    {
      env: {
        PORT: "0",
        DATABASE_URL: DATABASE_URL ?? "",
        RABBITMQ_URL: RABBITMQ_URL ?? "",
        E2E_SCHEMA: options.schema,
        ...options.env,
      },
      stopOn: [],
    },
  );
}

export async function placeOrder(url: string, id: string): Promise<number> {
  const response = await fetch(new URL("/orders", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name: `order ${id}` }),
  });
  await response.body?.cancel();
  return response.status;
}
