# OpenKnot quick-start

A small application: create a role, publish its event, and let a listener create a log. One private package, `@quick-start/app`, with every layer an ordinary folder under `src/`.

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

## Run

```sh
pnpm install --frozen-lockfile
pnpm example:quickstart
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

Variables are validated at startup. The start script loads a `.env` file next to the package with Node's `--env-file-if-exists`.

| Variable | Default | Owner |
| --- | --- | --- |
| `PORT`, `HTTP_HOST` | `3000`, `127.0.0.1` | [Node HTTP host](../../openknot-plugs/knot/knot-http-node/README.md), with its timeout and keep-alive tuning |
| `TRPC_BASE_PATH`, `TRPC_MAX_BODY_SIZE` | `/trpc/`, tRPC default | [tRPC handler](../../openknot-plugs/trpc/trpc-knot-server-handler/README.md) |
| `ACCESS_TOKEN`, `ACCESS_ACTOR` | `example-token`, `example-user` | [drizzle.ts](src/plugs/io/drizzle.ts) |

The example uses the ready host and protocol modules; custom hosts with their own settings are shown in the plug packages.

## Where things are

| Responsibility | File |
| --- | --- |
| Role and Log models with schema invariants | [role.ts](src/app/behavior/models/role.ts), [log.ts](src/app/behavior/models/log.ts) |
| Operations and their events | [operations.ts](src/app/behavior/operations.ts), [events.ts](src/app/behavior/events.ts) |
| Commands: operation → save → publish | [commands.ts](src/app/flow/commands.ts) |
| Guard and exposures | [guards.ts](src/app/flow/guards.ts), [exposures.ts](src/app/flow/exposures.ts) |
| Log listener | [listeners.ts](src/app/flow/listeners.ts) |
| State query | [queries.ts](src/app/flow/queries.ts) |
| Writers, publishers and access contracts | [ports.ts](src/app/flow/ports.ts) |
| Actor type | [actor.ts](src/app/flow/actor.ts) |
| Database, Unit of Work and health check | [database.ts](src/plugs/io/database.ts) |
| Readers, writers and identity | [drizzle.ts](src/plugs/io/drizzle.ts) |
| In-process event bus | [node-events.ts](src/plugs/channels/node-events.ts) |
| tRPC router with a protected procedure | [router.ts](src/plugs/transport/trpc/router.ts), [transport index](src/plugs/transport/index.ts) |
| Composition: input ports, plugs, HTTP host, tRPC and health | [application.ts](src/container/application.ts) |
| Entry point | [index.ts](src/index.ts) |

## How it works

- **Behavior is pure.** Models validate through their schemas; operations return `{ output: created(state), events }`.
- **Flow states the policy.** Commands persist, then publish. The exposure runs its guard first. Commands, queries and guards stay internal. The container lists the input ports in `inputs`; operations, handlers and contracts follow from their requirements.
- **Unit of Work.** The IO plug binds `defaultUnitOfWork` to [`@openknot-ts/drizzle-uow`](../../openknot-plugs/drizzle/drizzle-uow/README.md): a command's first database call opens its SQLite transaction, which its readers and writers share. Writers return `upserted(row)` from Drizzle `returning()`. Publications wait for the commit; a failure before it rolls back and discards them.
- **Events behave like a broker.** The publisher returns once the event is emitted; the listener runs on its own with its own transaction and reports its own failures. Only serialized trace context travels with each event.
- **tRPC.** `trpcRouter({ requirements, routes })` receives exposures as native resolvers, as in `.mutation(createRoleExposure)`. The container selects `http` and `trpcHttp`; nothing constructs a server by hand.
- **Identity.** The router uses `trpcAuthentication`, which resolves the bearer token through IO's `identity` (`actorResolver`). Invalid credentials answer 401 before Flow runs. The guard authorizes with `ctx.actor?.userId`.
- **Health.** IO declares `databaseHealth` beside the database; the container selects [`@openknot-ts/knot-health`](../../openknot-plugs/knot/knot-health/README.md)'s `healthHttp`. Readiness is down while starting or stopping; only `/health` depends on SQLite.
- **Tracing.** HTTP trace headers travel through the Role → Log chain beside the event, never inside it. Add [`provideOpenTelemetry()`](../../openknot-plugs/opentelemetry/opentelemetry-tracing/README.md) to the container to record spans; the application starts no SDK.
- **Lifecycle.** The listener starts before HTTP intake; on stop, admitted requests finish, then the listener stops and SQLite closes.

## Focused examples and tests

Features this application leaves out on purpose:

```sh
pnpm --filter @openknot-ts/flow example:topics          # guarded topics and broadcasts
pnpm --filter @openknot-ts/flow example                 # listeners and schedulers
pnpm --filter @openknot-ts/flow example:trace           # console timing without a telemetry SDK
pnpm --filter @openknot-ts/opentelemetry-tracing example # OpenTelemetry SDK setup
pnpm --filter @openknot-ts/knot-pubsub example          # in-memory pub/sub
pnpm --filter @openknot-ts/knot-http-bun example        # the Bun host (Bun 1.4.4+)
```

A broker-backed publisher and listener: [`@openknot-ts/rabbitmq`](../../openknot-plugs/rabbitmq/README.md) ([messaging.ts](../../openknot-plugs/rabbitmq/examples/messaging.ts)). Realtime delivery: [`@openknot-ts/knot-pubsub`](../../openknot-plugs/knot/knot-pubsub/README.md). Auth0: [`@openknot-ts/auth0-authentication`](../../openknot-plugs/trpc/middleware/auth0-authentication/README.md).

[test/app.test.ts](test/app.test.ts) covers the workflow, validation, guards, probes, configuration, listener failures, cancellation, draining, actor resolution, propagation and shutdown; [test/layers.test.ts](test/layers.test.ts) keeps guard declarations out of the plugs.
