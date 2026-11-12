# @openknot-ts/rabbitmq

RabbitMQ listeners and publishers for Flow ports, over `rabbitmq-client`. Declare the topology once; the bindings it returns are typed by it and manage the connection, topology, confirms, JSON framing and draining.

## Usage

```ts
import { rabbitTopology } from "@openknot-ts/rabbitmq";

export const { rabbitListener, rabbitPublisher } = rabbitTopology({
  exchanges: [{ exchange: "roles", type: "topic", durable: true }],
  queues: [{ queue: "roles.audit", durable: true }],
  routes: [{ exchange: "roles", routingKey: "role.created" }],
  queueBindings: [{ exchange: "roles", queue: "roles.audit", routingKey: "role.*" }],
});
```

```ts
const consuming = rabbitListener({ queue: "roles.audit" }, roleCreated);
const publishing = rabbitPublisher({ exchange: "roles", routingKey: "role.created" }, roleEvents);

export const application = defineApplication({
  modules: [flow, providePlugs([consuming, publishing])],
});
```

`roleCreated` is an ordinary Flow listener and `roleEvents` an ordinary publisher. Only selected bindings start: a publisher-only application starts no consumer, and both share one connection when selected together.

## API

`rabbitTopology({ exchanges, queues, routes, queueBindings?, exchangeBindings?, connection? })` returns:

| Member | Description |
| --- | --- |
| `rabbitListener(config?, listener)` | A listener binding. `config` names the queue (optional with one queue) and native consumer fields: `qos`, `concurrency`, `consumerTag`, `exclusive`, and a Standard Schema `schema`. |
| `rabbitPublisher(config?, publisher)` | A publisher binding. `config` names the route (optional with one route), `properties` (AMQP fields or a function of the message), native `publisher` options such as `maxAttempts`, and `configure(publisher)` for native setup and events. |
| `rabbitHealthCheck({ name?, timeoutMs? })` | Up while the connection is ready. |
| `rabbitConnection` | The connection as a `ConnectionWatch`, for the outbox, cache and replication. |
| `rabbitNativeConnection` | The selected native connection reference. |

Package exports: `rabbitTopology`, `rabbit` (the default connection), `rabbitClient({ requirements?, create, startupTimeoutMs? })`, `rabbitErrors`, `rabbitConnectionOf(connection)`.

Queue names, exchanges and routes are inferred as literals: unknown names and a routing key of another exchange fail compilation. `routes` is the publish contract; binding keys such as `role.*` are subscription patterns. The default exchange `""` needs no declaration and routes to a declared queue.

## Configuration

| Variable | Default |
| --- | --- |
| `RABBITMQ_URL` | Required `amqp://` or `amqps://` URL |
| `RABBITMQ_STARTUP_TIMEOUT_MS` | `10000` |
| `RABBITMQ_HEARTBEAT_SECONDS` | `60`; `0` disables heartbeats |
| `RABBITMQ_ACQUIRE_TIMEOUT_MS` | `20000` |

These belong to the default `rabbit` connection. Another connection uses its own config:

```ts
import { Connection } from "rabbitmq-client";

const settings = config({ BUS_URL: z.url(), BUS_NAME: z.string() });

const connection = rabbitClient({
  requirements: { settings },
  create: ({ settings }) =>
    new Connection({
      url: settings.BUS_URL,
      connectionName: settings.BUS_NAME,
      maxChannels: 128,
      tls: { servername: "broker.internal" },
    }),
});

const bindings = rabbitTopology({ connection, exchanges, queues, routes });
```

## Delivery

- Startup: connection ready, topology declared (durable by default), publishers, then consumers. A broker refusal fails startup. Declarations are reapplied on native reconnection.
- A delivery is acknowledged after the whole Flow execution: handler, Unit of Work, hooks, effects and confirmed publications.
- Decode, schema and pre-commit failures are rejected without requeue (to the queue's DLX if configured). A delivery arriving after intake closed is requeued. Post-commit failures are acknowledged, so committed work does not repeat.
- Publications are JSON, persistent, confirmed and mandatory: an unroutable message or a negative confirm rejects the call. One send attempt by default.
- Unreturnable failures (connection errors, topology recovery, and deliveries that fail to decode before reaching Flow, with the queue and message id) go to `rabbitErrors`, which writes each through the application's [`logger`](../../openknot-capabilities/logging/README.md) and reports it to the [error reporter](../../openknot-capabilities/error-reporting/README.md) when one is bound; rebind it with `unit({ provides: rabbitErrors, factory })` to handle them elsewhere. A listener's own failures are logged and reported once by Flow.
- Shutdown stops intake, drains admitted deliveries, closes publishers after outstanding confirms, then the connection.
- With tracing, publications create producer spans and propagate only the configured fields; the actor never enters headers.
- In rabbitmq-client 5.0.5 the declared `onReturn` publisher option is unused; listen with `configure: (publisher) => publisher.on("basic.return", handler)`.

## Example and tests

[examples/messaging.ts](examples/messaging.ts) shows a topology with both bindings. Against a disposable broker:

```sh
pnpm build
docker run --detach --rm --name openknot-rabbitmq-test \
  --publish 127.0.0.1:5679:5672 \
  --env RABBITMQ_DEFAULT_USER=openknot \
  --env RABBITMQ_DEFAULT_PASS=openknot rabbitmq:4.4.0-alpine
docker exec openknot-rabbitmq-test rabbitmq-diagnostics -q check_running
env RABBITMQ_URL=amqp://openknot:openknot@127.0.0.1:5679 pnpm --filter @openknot-ts/rabbitmq test:broker
env RABBITMQ_URL=amqp://openknot:openknot@127.0.0.1:5679 pnpm --filter @openknot-ts/rabbitmq example
docker stop openknot-rabbitmq-test
```
