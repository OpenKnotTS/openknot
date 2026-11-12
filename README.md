# OpenKnot

> **Preview.** OpenKnot is in preview: APIs may change between 0.x versions until 1.0. Pin exact versions and expect breaking changes in minor releases.

OpenKnot is a TypeScript backend framework built around a stable application architecture. It separates business rules, application workflows and infrastructure, giving developers and coding agents a consistent structure to work within as a project grows.

## Core features

- **Functional, strongly typed DI.** No classes, decorators or string keys. Every definition names its dependencies as typed references; a missing implementation fails to compile, and startup reports it with its path, such as `expose → handler → userEventsPublisher`.
- **An architecture that cannot drift.** Each layer accepts only what belongs to it. An operation can depend only on readers and other operations, so business rules never write or publish. An application lists only input ports; handlers, guards and contracts are reached through requirements. A misplaced dependency is a type error.
- **Errors as values.** Operations and handlers return typed outcomes, and each handler's error union is inferred from what it calls.
- **A managed Unit of Work.** Commands persist in one transaction and publish after commit, without transaction code in the application.
- **Native plugs.** Databases, brokers and HTTP hosts keep their SDK's full API; replacing one changes a plug, not the application.

These boundaries give developers and coding agents one place and one pattern for every change, so a project stays consistent as it grows.

## Architecture

| Part | Responsibility |
| --- | --- |
| **Behavior** | Pure models, state invariants and operations that calculate business changes. |
| **Flow** | Commands, queries, guards and ports; coordinates persistence and event publication within a Unit of Work. |
| **Plugs** | Implement the application's contracts using databases, HTTP transports, messaging clients and other native SDKs. |
| **Container / Wire** | Selects the application's input ports and the implementations it uses, connects their dependencies, validates configuration and manages startup, scopes and shutdown. |

Behavior owns the rules. Flow decides how a use case runs. Plugs perform the infrastructure work through contracts. The container chooses which input ports the application exposes and which implementations it uses.

## Primitives

| Layer | Primitive | Role |
| --- | --- | --- |
| Behavior | `model` | State, its invariants, and the mutations and queries it allows. |
| | `operation` | One business change: its fixed output and the events it declares. |
| | `reader` | A read contract that operations, queries and guards depend on. |
| | `error` | A functional error, returned as a failure and checked by its `type`. |
| Flow | `command`, `query` | Handlers that run a use case inside a Unit of Work. |
| | `guard` | Admission policy that runs before a handler. |
| | `hook`, `unitOfWork` | Unit of Work lifecycle and transaction boundaries. |
| | `writer`, `publisher`, `persist` | Output contracts for persistence and events, and applying an operation's output. |
| | `expose`, `listener`, `scheduler`, `topic`, `broadcast` | Input ports that transports, brokers and timers call. |
| Plugs | `plug`, `resource`, `unit`, `config`, `decorate` | Implementations, managed native resources, validated settings and wrappers. |
| Container | `defineApplication`, `runApplication` | Input ports, selected implementations, startup and shutdown tasks, and the lifecycle. |

## Install

```sh
pnpm add @openknot-ts/core
```

`@openknot-ts/core` contains Wire, Behavior and Flow. Plugs are separate packages; the example below serves tRPC on Fastify:

```sh
pnpm add @openknot-ts/fastify-server @openknot-ts/trpc-fastify @openknot-ts/trpc-router @openknot-ts/trpc-context fastify @trpc/server zod
```

## Example

Changing a user's email, step by step. The blocks are one runnable file, [readme-example.ts](openknot/test/readme-example.ts), which also holds the imports.

### 1. Behavior

Pure business rules. The schema validates every result a mutation returns; an invalid one becomes a `ModelValidationError`. An operation can require only readers and other operations: giving it a writer or publisher fails to compile, so business rules cannot persist or publish.

```ts
const userSchema = z.object({ id: z.string(), name: z.string().min(1), email: z.email() }).readonly();
type UserState = z.infer<typeof userSchema>;

type UserEvent = Event & {
  readonly type: "UserEmailChanged";
  readonly id: string;
  readonly email: string;
};

const User = model({
  invariants: userSchema,
  mutations: {
    changeEmail: (user: UserState, email: string) => success({ ...user, email }),
  },
});

type ChangeEmailInput = { user: UserState; email: string };

const emailExistsReader = reader<(email: string) => Promise<boolean>>();

const EmailAlreadyTaken = error("EmailAlreadyTaken", (email: string) => ({
  message: `Email ${email} is already taken`,
  email,
}));

const changeUserEmailOperation = operation<ChangeEmailInput, UserState, UserEvent>()({
  requirements: { emailExistsReader },
  run: async ({ user, email }, ctx) => {
    if (await ctx.emailExistsReader(email)) {
      return failure(EmailAlreadyTaken(email));
    }

    const changed = User.changeEmail(user, email);

    if (changed.isError) {
      return changed;
    }

    return success({
      output: updated(changed.value),
      events: [{ type: "UserEmailChanged", id: changed.value.id, email }],
    });
  },
});
```

### 2. Flow

Flow coordinates the use case in two parts.

#### Orchestration

The command orchestrates the use case: load the user, apply the operation, persist and publish. It runs in a Unit of Work, and the event is delivered only after commit; on rollback it is discarded.

```ts
type ChangeEmailRequest = { id: string; email: string };

const findUserReader = reader<(id: string) => Promise<UserState | undefined>>();
const saveUserWriter = writer<(user: UserState) => Promise<Upserted<UserState>>>();
const userEventsPublisher = publisher<UserEvent>();

const UserNotFound = error("UserNotFound", (id: string) => ({ message: `User ${id} was not found`, id }));

const changeUserEmailCommand = command<ChangeEmailRequest, UserState>()({
  requirements: { findUserReader, changeUserEmailOperation, saveUserWriter, userEventsPublisher },
  run: async ({ id, email }, ctx) => {
    const user = await ctx.findUserReader(id);

    if (user === undefined) {
      return failure(UserNotFound(id));
    }

    const result = await ctx.changeUserEmailOperation({ user, email });

    if (result.isError) {
      return result;
    }

    const saved = await ctx.saveUserWriter(result.value.output.next);

    for (const event of result.value.events) {
      await ctx.userEventsPublisher.publish(event);
    }

    return success(saved.next);
  },
});
```

#### Exposure

The input ports transports call. Guards belong to the exposure and run before its handler, so the command knows nothing about access. Only input ports can be an application's inputs: listing a command or guard there fails to compile. A read needs no handler of its own; it runs inline in its exposure.

```ts
const isAdminReader = reader<(userId: string | undefined) => Promise<boolean>>();
const AccessDenied = error("AccessDenied");

const isAdmin = guard({
  requirements: { isAdminReader },
  run: async (_input, ctx) => ((await ctx.isAdminReader(ctx.actor?.userId)) ? success() : failure(AccessDenied())),
});

const changeEmailEndpoint = expose({ handler: changeUserEmailCommand, guards: { isAdmin } });

const getUserEndpoint = expose<string>()({
  requirements: { findUserReader },
  run: async (id, ctx) => success(await ctx.findUserReader(id)),
});

const userApi = expose.compose({ changeEmailEndpoint, getUserEndpoint });
```

### 3. Plugs

Implementations of the contracts, grouped where they belong: `io` holds in-memory storage and a console publisher, `transport` the actor behind a Bearer token and tRPC procedures over the input ports.

```ts
const usersById = new Map<string, UserState>([["u1", { id: "u1", name: "Ada", email: "ada@example.com" }]]);

const inMemoryUserReaders = plug({
  port: reader.compose({ findUserReader, emailExistsReader, isAdminReader }),
  bind: () => ({
    findUserReader: async (id: string) => usersById.get(id),
    emailExistsReader: async (email: string) => [...usersById.values()].some((user) => user.email === email),
    isAdminReader: async (userId: string | undefined) => userId === "admin",
  }),
});

const inMemoryUserWriter = plug({
  port: saveUserWriter,
  bind: () => async (user: UserState) => {
    usersById.set(user.id, user);
    return upserted(user);
  },
});

const consoleEventsPublisher = plug({
  port: userEventsPublisher,
  bind: () => (event: UserEvent) => {
    console.log(event.type, event.email);
  },
});

const io = providePlugs([inMemoryUserReaders, inMemoryUserWriter, consoleEventsPublisher]);

const tokenActors = actorResolver({
  resolve: (token: string) => (token === "admin-token" ? { userId: "admin" } : undefined),
});

const userRouter = trpcRouter({
  requirements: { authentication: trpcAuthentication, changeEmailEndpoint, getUserEndpoint },
  routes: ({ trpc, authentication, changeEmailEndpoint, getUserEndpoint }) => ({
    changeEmail: trpc.procedure
      .use(authentication)
      .input(z.object({ id: z.string(), email: z.email() }))
      .mutation(changeEmailEndpoint),
    getUser: trpc.procedure.input(z.string()).query(getUserEndpoint),
  }),
});

const transport = providePlugs([tokenActors, userRouter]);
```

### 4. Application

The application names its input ports and selects implementations; everything else follows from requirements. A missing implementation fails to compile.

```ts
const app = await runApplication(
  defineApplication({
    inputs: [userApi],
    modules: [io, transport, fastifyHttp, trpcFastify],
  }),
);

console.log(`tRPC on Fastify at ${app.resolve(fastifyServer).url}/trpc`);
```

Call it with the admin token:

```sh
curl -X POST http://127.0.0.1:3000/trpc/changeEmail \
  -H "authorization: Bearer admin-token" -H "content-type: application/json" \
  -d '{"id":"u1","email":"ada@new.example"}'
```

## Unit of Work and lifecycle

- Every command and query runs in a Unit of Work, which the handlers it calls join. With `@openknot-ts/drizzle-uow`, the database transaction opens on first use.
- `publish()` waits for the commit and is discarded on rollback; `@openknot-ts/outbox` stores it in the same transaction.
- Cancellation is checked before every port call; nothing is interrupted after commit.
- `runApplication()` validates the graph and the configuration first, then opens resources in dependency order, then listeners and HTTP hosts, then startup tasks.
- On SIGINT or SIGTERM, hosts stop accepting work and drain what they admitted, and resources close in reverse order.

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
  container/        # input ports, selected implementations and lifecycle
  index.ts          # start the application
```

The same boundaries can become independent packages without changing their responsibilities. Flow depends on Behavior; plugs depend on the contracts they implement; the container composes the application.

## Packages

| Package | Purpose |
| --- | --- |
| [`@openknot-ts/core`](openknot/README.md) | The three core packages together. |
| [`@openknot-ts/wire`](openknot-wire/README.md) | Dependency injection, configuration and resource lifecycle. |
| [`@openknot-ts/behavior`](openknot-behavior/README.md) | Models, operations, reader contracts and functional errors. |
| [`@openknot-ts/flow`](openknot-flow/README.md) | Application execution, Unit of Work, guarded ports and messaging contracts. |
| [Capabilities](openknot-capabilities/README.md) | Optional health, tracing, logging, error reporting, outbox, caching, replication, versioning and locking. |

### Plugs

Each plug keeps its SDK's options and types, and adds dependency injection, managed lifecycle and the framework contract it implements.

| Area | Packages |
| --- | --- |
| HTTP hosts | [`fastify-server`](openknot-plugs/fastify/fastify-server/README.md), [`knot-http-node`](openknot-plugs/knot/knot-http-node/README.md), [`knot-http-bun`](openknot-plugs/knot/knot-http-bun/README.md) |
| Protocols | [`trpc-router`](openknot-plugs/trpc/trpc-router/README.md), [`trpc-context`](openknot-plugs/trpc/trpc-context/README.md), [`trpc-fastify`](openknot-plugs/trpc/trpc-fastify/README.md), [`trpc-knot-server-handler`](openknot-plugs/trpc/trpc-knot-server-handler/README.md), [`knot-rest`](openknot-plugs/knot/knot-rest/README.md), [`knot-rest-fastify`](openknot-plugs/knot/knot-rest-fastify/README.md), [`knot-rest-http-node`](openknot-plugs/knot/knot-rest-http-node/README.md), [`knot-rest-http-bun`](openknot-plugs/knot/knot-rest-http-bun/README.md) |
| Data | [`drizzle-uow`](openknot-plugs/drizzle/drizzle-uow/README.md), [`drizzle-versioning`](openknot-plugs/drizzle/drizzle-versioning/README.md), [`drizzle-outbox`](openknot-plugs/drizzle/drizzle-outbox/README.md), [`postgres-client`](openknot-plugs/postgres/postgres-client/README.md) |
| Messaging | [`rabbitmq`](openknot-plugs/rabbitmq/README.md), [`knot-pubsub`](openknot-plugs/knot/knot-pubsub/README.md) |
| Redis | [`redis-client`](openknot-plugs/redis/redis-client/README.md), [`redis-lock`](openknot-plugs/redis/redis-lock/README.md), [`redis-replication`](openknot-plugs/redis/redis-replication/README.md) |
| Health | [`knot-health`](openknot-plugs/knot/knot-health/README.md), [`knot-health-bun`](openknot-plugs/knot/knot-health-bun/README.md) |
| Identity | [`auth0-actor`](openknot-plugs/auth0/auth0-actor/README.md), [`auth0-authentication`](openknot-plugs/trpc/middleware/auth0-authentication/README.md) |
| Observability | [`opentelemetry-tracing`](openknot-plugs/opentelemetry/opentelemetry-tracing/README.md), [`pino-logging`](openknot-plugs/pino/pino-logging/README.md), [`sentry-node`](openknot-plugs/sentry/sentry-node/README.md), [`sentry-bun`](openknot-plugs/sentry/sentry-bun/README.md) |
| Locks | [`knot-lock`](openknot-plugs/knot/knot-lock/README.md) |

## Development

Requires Node.js 24.11+ and pnpm 10.20.0; the complete test suite also requires Bun 1.4.4+. Versions are listed in `.tool-versions`.

From the repository root, run `pnpm install --frozen-lockfile`, then `pnpm check` for formatting, lint, build and type checks, and `pnpm test` for the test suite.

## License

[MIT](LICENSE)
