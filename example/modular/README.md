# OpenKnot modular

The [quick-start](../quick-start/README.md) application split into packages: create a role, publish its event, and let a listener create a log.

```text
tRPC createRole
  → authentication middleware → trusted actor
  → createRoleExposure + userHasAccessToRoleGuard
  → createRoleCommand → createRoleOp → Role.create
  → saveRoleWriter → SQLite commit → rolePublisher
  → Node EventEmitter → roleChangedListener
  → createLogFromRoleCommand → createLogFromRoleOp → Log.createFromRole
  → saveLogWriter → SQLite commit → logPublisher
```

| Package | Folder | Contents |
| --- | --- | --- |
| `@modular/behavior` | `app/behavior` | Models, operations, events, readers |
| `@modular/flow` | `app/flow` | Ports, exposures, listener; commands, queries and guards stay private |
| `@modular/io` | `plugs/io` | Database, Unit of Work, readers, writers, identity |
| `@modular/channels` | `plugs/channels` | In-process event bus |
| `@modular/transport` | `plugs/transport` | tRPC router |
| `@modular/container` | `container` | Composition, entry point and tests |

Each package has its own `package.json`, `src/index.ts`, exports and build. Cross-package imports use public exports and `workspace:*`.

## Run

```sh
pnpm install --frozen-lockfile
pnpm example:modular
```

```sh
curl http://127.0.0.1:3000/livez
curl http://127.0.0.1:3000/readyz
curl http://127.0.0.1:3000/health

curl http://127.0.0.1:3000/trpc/createRole \
  -H 'Authorization: Bearer example-token' \
  -H 'Content-Type: application/json' \
  -d '{"id":"r1","name":"Dispatcher","active":true}'

curl http://127.0.0.1:3000/trpc/getState \
  -H 'Authorization: Bearer example-token'
```

`createRole` returns the role once committed; the listener then creates `{ id: "r1", action: 'Created role "Dispatcher"' }`, which `getState` shows. SQLite runs in memory, so data resets on restart. Ctrl+C stops cleanly at any point.

## Configuration

Variables are validated at startup. The start script loads a `.env` file next to the container package with Node's `--env-file-if-exists`.

| Variable | Default | Owner |
| --- | --- | --- |
| `PORT`, `HTTP_HOST` | `3000`, `127.0.0.1` | [Node HTTP host](../../openknot-plugs/knot/knot-http-node/README.md), with its timeout and keep-alive tuning |
| `TRPC_BASE_PATH`, `TRPC_MAX_BODY_SIZE` | `/trpc/`, tRPC default | [tRPC handler](../../openknot-plugs/trpc/trpc-knot-server-handler/README.md) |
| `ACCESS_TOKEN`, `ACCESS_ACTOR` | `example-token`, `example-user` | [drizzle.ts](plugs/io/src/drizzle.ts) |

The example uses the ready host and protocol modules; custom hosts with their own settings are shown in the plug packages.

## Where things are

| Responsibility | File |
| --- | --- |
| Role and Log models with schema invariants | [role.ts](app/behavior/src/models/role.ts), [log.ts](app/behavior/src/models/log.ts) |
| Operations and their events | [operations.ts](app/behavior/src/operations.ts), [events.ts](app/behavior/src/events.ts) |
| Commands: operation → save → publish | [commands.ts](app/flow/src/commands.ts) |
| Guard and exposures | [guards.ts](app/flow/src/guards.ts), [exposures.ts](app/flow/src/exposures.ts) |
| Log listener | [listeners.ts](app/flow/src/listeners.ts) |
| State query | [queries.ts](app/flow/src/queries.ts) |
| Writers, publishers and access contracts | [ports.ts](app/flow/src/ports.ts) |
| Flow provision and public subpath exports | [index.ts](app/flow/src/index.ts), [package.json](app/flow/package.json) |
| Actor type | [actor.ts](app/flow/src/actor.ts) |
| Database, Unit of Work and health check | [database.ts](plugs/io/src/database.ts) |
| Readers, writers and identity | [drizzle.ts](plugs/io/src/drizzle.ts) |
| In-process event bus | [node-events.ts](plugs/channels/src/node-events.ts) |
| tRPC router with a protected procedure | [router.ts](plugs/transport/src/trpc/router.ts), [transport index](plugs/transport/src/index.ts) |
| Composition: layers, HTTP host, tRPC and health | [application.ts](container/src/application.ts) |
| Entry point | [serve.ts](container/src/serve.ts) |

## How it works

The application is the same as the quick-start's; see its [How it works](../quick-start/README.md#how-it-works). What the split adds:

- **Public exports.** The Flow package exports its ports through subpaths (`@modular/flow/ports`, `/exposures`, `/listeners`); commands, queries and guards are not importable. Plugs import only those contracts.
- **Independent builds.** Every package builds and typechecks on its own; the container consumes their emitted declarations.
- **One composition root.** Only the container imports every layer and selects the HTTP host, tRPC handler and health probes.

## Focused examples

```sh
pnpm --filter @openknot-ts/flow example:topics          # guarded topics and broadcasts
pnpm --filter @openknot-ts/flow example                 # listeners and schedulers
pnpm --filter @openknot-ts/flow example:trace           # console timing without a telemetry SDK
pnpm --filter @openknot-ts/opentelemetry-tracing example # OpenTelemetry SDK setup
pnpm --filter @openknot-ts/knot-pubsub example          # in-memory pub/sub
pnpm --filter @openknot-ts/knot-http-bun example        # the Bun host (Bun 1.4.4+)
```

A broker-backed publisher and listener: [`@openknot-ts/rabbitmq`](../../openknot-plugs/rabbitmq/README.md) ([messaging.ts](../../openknot-plugs/rabbitmq/examples/messaging.ts)). Tracing: [`@openknot-ts/opentelemetry-tracing`](../../openknot-plugs/opentelemetry/opentelemetry-tracing/README.md) ([SDK setup](../../openknot-plugs/opentelemetry/opentelemetry-tracing/examples/tracing.ts)). Realtime delivery: [`@openknot-ts/knot-pubsub`](../../openknot-plugs/knot/knot-pubsub/README.md). Auth0: [`@openknot-ts/auth0-authentication`](../../openknot-plugs/trpc/middleware/auth0-authentication/README.md).

## Tests

- [app.test.ts](container/test/app.test.ts): the workflow, validation, guards, probes, configuration, listener failures, cancellation, draining, actor resolution, propagation and shutdown.
- [package-exports.test.ts](container/test/package-exports.test.ts): an isolated consumer compiles against the public exports; handlers and guards stay private.
- [layers.test.ts](container/test/layers.test.ts): guard declarations stay out of the plugs.

### End-to-end over real services

`pnpm test:e2e` runs the same behavior, flow and transport packages with [test-local plugs](container/test/e2e-application.ts) over PostgreSQL (Drizzle Unit of Work), RabbitMQ and a Redis read-through cache:

- [e2e.integration.ts](container/test/e2e.integration.ts): requests over tRPC, probes, authentication, a commit Postgres refuses (publishing nothing), the Role → Log chain through RabbitMQ, cache eviction on commit, concurrent requests, a dead-lettered listener failure and a stop that lets running requests finish.
- [resilience.integration.ts](container/test/resilience.integration.ts): Redis, RabbitMQ and Postgres outages, a [killed producer](container/test/crash-producer.ts) whose deliveries the next process completes, and 2,100 concurrent requests without heap growth.
- [outbox.integration.ts](container/test/outbox.integration.ts): a separate [order service](container/test/outbox-application.ts) with `@openknot-ts/postgres-client`, `@openknot-ts/drizzle-outbox/pg` and `@openknot-ts/outbox` over PostgreSQL, RabbitMQ and REST, checking the delivered `messageId`: ordered delivery after a broker outage, a [killed process](container/test/outbox-producer.ts)'s record delivered after its lease, two instances delivering each event once, and Postgres failures.

Each run creates its own schema, exchange, queues and cache keys and removes them. Without the URLs the tests are skipped; the outages also need the container names, and the containers must keep fixed host ports across stop and start:

```sh
docker run -d --name openknot-postgres -e POSTGRES_PASSWORD=openknot -p 5432:5432 postgres:17-alpine
docker run -d --name openknot-rabbitmq -p 5672:5672 rabbitmq:4.2.0-alpine
docker run -d --name openknot-redis -p 6379:6379 redis:7-alpine
env DATABASE_URL=postgres://postgres:openknot@127.0.0.1:5432/postgres RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 REDIS_URL=redis://127.0.0.1:6379 POSTGRES_CONTAINER=openknot-postgres RABBITMQ_CONTAINER=openknot-rabbitmq REDIS_CONTAINER=openknot-redis pnpm test:e2e
```
