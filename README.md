# OpenKnot

> **Preview.** OpenKnot is in preview: APIs may change between 0.x versions until 1.0. Pin exact versions and expect breaking changes in minor releases.

OpenKnot is a TypeScript backend framework built around a stable application architecture. It separates business rules, application workflows and infrastructure, giving developers and coding agents a consistent structure to work within as a project grows.

## Built for architectural consistency

Agent-assisted development works better when a task has a clear home and follows an established pattern. OpenKnot is designed to make those decisions predictable:

- **Clear responsibilities.** Business rules, workflow policies and infrastructure implementations belong to separate layers.
- **Explicit dependencies.** Each definition declares what it needs through typed references, making its dependencies visible in the code.
- **Consistent execution.** Validation, functional errors, transactions, cancellation and resource cleanup follow shared framework contracts.
- **Replaceable infrastructure.** Changing a database, transport or broker happens through plugs that implement application contracts.

The goal is to reduce architectural guesswork: an agent adding a feature can follow the same boundaries and conventions as the developers and agents that came before it.

## Architecture

| Part | Responsibility |
| --- | --- |
| **Behavior** | Pure models, state invariants and operations that calculate business changes. |
| **Flow** | Commands, queries, guards and ports; coordinates persistence and event publication within a Unit of Work. |
| **Plugs** | Implement the application's contracts using databases, HTTP transports, messaging clients and other native SDKs. |
| **Container / Wire** | Selects modules, connects their dependencies, validates configuration and manages startup, scopes and shutdown. |

Behavior owns the rules. Flow decides how a use case runs. Plugs perform the infrastructure work through contracts. The container chooses which implementations the application uses.

## Project structure

A small application can keep the separation in ordinary source folders:

```text
src/
  app/
    behavior/       # models, operations, events and reader contracts
    flow/           # commands, queries, guards and input/output ports
  plugs/
    io/             # database and external service implementations
    channels/       # message publishers and listeners
    transport/      # HTTP routes and protocol mapping
  container/        # module selection and application lifecycle
  index.ts          # start the application
```

The same boundaries can become independent packages without changing their responsibilities. Flow depends on Behavior; plugs depend on the contracts they implement; the container composes the application.

## Core and integrations

Install the core with `pnpm add @openknot-ts/core`. It includes Wire, Behavior and Flow, with separate import paths for each layer. Infrastructure plugs are installed and selected explicitly.

| Package | Purpose |
| --- | --- |
| [`@openknot-ts/core`](openknot/README.md) | The three core packages together. |
| [`@openknot-ts/wire`](openknot-wire/README.md) | Dependency injection, configuration and resource lifecycle. |
| [`@openknot-ts/behavior`](openknot-behavior/README.md) | Models, operations, reader contracts and functional errors. |
| [`@openknot-ts/flow`](openknot-flow/README.md) | Application execution, Unit of Work, guarded ports and messaging contracts. |
| [Capabilities](openknot-capabilities/README.md) | Optional health, tracing, outbox, caching, replication, versioning and locking. |

Plugs preserve their native SDK's options and types. Available integrations cover [Node and Bun HTTP hosts, REST and local pub/sub](openknot-plugs/knot/README.md), [Fastify](openknot-plugs/fastify/README.md), [tRPC](openknot-plugs/trpc/README.md), [RabbitMQ](openknot-plugs/rabbitmq/README.md), [Drizzle](openknot-plugs/drizzle/README.md), [PostgreSQL](openknot-plugs/postgres/README.md), [Redis](openknot-plugs/redis/README.md), [OpenTelemetry](openknot-plugs/opentelemetry/README.md) and [Auth0](openknot-plugs/auth0/README.md).

## Development

Requires Node.js 24.11+ and pnpm 10.20.0; the complete test suite also requires Bun 1.4.4+. Versions are listed in `.tool-versions`.

From the repository root, run `pnpm install --frozen-lockfile`, then `pnpm check` for formatting, lint, build and type checks, and `pnpm test` for the test suite.

## License

[MIT](LICENSE)
