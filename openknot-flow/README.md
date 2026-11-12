# @openknot-ts/flow

Application flow: command and query handlers, a Unit of Work with lifecycle hooks, guarded input ports, typed output ports and realtime contracts. Handlers call [Behavior](../openknot-behavior/README.md) operations, then persist and publish explicitly. The root entry imports no container; `@openknot-ts/flow/wire` adds `provideFlow()` and the DI integration.

```sh
pnpm build
pnpm --filter @openknot-ts/flow test
pnpm --filter @openknot-ts/flow example            # examples/inputs.ts: a scheduler and a listener
pnpm --filter @openknot-ts/flow example:handlers   # examples/handlers.ts
pnpm --filter @openknot-ts/flow example:uow        # examples/unit-of-work.ts
pnpm --filter @openknot-ts/flow example:publisher  # examples/publisher.ts
pnpm --filter @openknot-ts/flow example:topics     # examples/topics.ts
pnpm --filter @openknot-ts/flow example:trace      # examples/trace.ts
pnpm --filter @openknot-ts/flow exec node examples/role-data.ts
```

## Overview

| Kind | Primitives | Notes |
| --- | --- | --- |
| Handlers | `command`, `query` | Internal; called through `requirements`. |
| Inputs | `expose`, `listener`, `scheduler`, `topic`, `broadcast` | An application's `inputs`. Plugs and transports invoke them. |
| Outputs | `reader` (from Behavior), `writer`, `publisher` | Implemented by plugs. |
| Policies | `guard`, `hook`, `unitOfWork` | Internal dependencies. |

Every definition declares its types on the head, so it reads like a signature: `command<Input, Output>()({ ... })`, `query<Input, Output>()`, `guard<Input>()`, `hook<Input>()`, `listener<Input>()`, `expose<Input, Output>()`. Output is optional; requirements and errors are inferred. With nothing to declare, `query({ ... })` takes no input. Commands, queries, exposures, listeners, schedulers, guards and hooks accept an optional `tag`, such as `command<string>()({ tag: "role.rename", ... })`, which names their executions in logs and spans.

## Handlers

```ts
import { success } from "@openknot-ts/behavior";
import { command, expose, query } from "@openknot-ts/flow";

const getCount = query({
  requirements: { readCount },
  run: (_input, ctx) => success(ctx.readCount()),
});

const increment = command<number>()({
  requirements: { addCount, getCount },
  run: async (amount, ctx) => {
    ctx.addCount(amount);
    return ctx.getCount();
  },
});

const incrementEndpoint = expose({ handler: increment });
```

- A required handler is called directly: `ctx.handler(input, options?)`. Nested calls share the caller's scope and Unit of Work.
- `HandlerInput`, `HandlerOutput` and `HandlerErrors` extract a handler's contract. A command can take its input from an operation: `command<OperationInput<typeof renameRole>>()`.
- A command calls its operation and handles the output explicitly: `unchanged` returns `current` without writing or publishing; otherwise persist `next` (or delete `previous`) and publish the events.

## Inputs

### Exposures and guards

```ts
import { error, failure, success } from "@openknot-ts/behavior";
import { expose, guard } from "@openknot-ts/flow";

const RoleAccessDenied = error("RoleAccessDenied");

const canReadRoles = guard<{ readonly permissions: readonly string[] }>()({
  run: (input) => (input.permissions.includes("roles:read") ? success() : failure(RoleAccessDenied())),
});

const getRole = expose<{ readonly roleId: string }>()({
  requirements: { findRoleById },
  guards: { canReadRoles },
  run: async (input, ctx) => success(await ctx.findRoleById(input.roleId)),
});

const role = await app.resolve(getRole)({
  input: { roleId: "r1" },
  canReadRoles: { permissions: ["roles:read"] },
});
```

- A port that only forwards names its handler: `expose({ handler, guards?, view? })`, `listener({ handler })`, `scheduler({ handler, schedule })`. A port declares either `handler` or `requirements`/`run`.
- `view` is a query of the handler's Unit of Work whose input is the handler's output. It runs after the handler succeeds, in the same execution; its output is the response and its failure rolls back.
- `guards` is a named object of `guard()` definitions. Each returns `success()` or `failure(error)`; they run in key order and stop at the first failure, before the handler's dependencies are resolved.
- The request is `GuardRequest<I, G>` (`GuardInputs<G> & InputField<I>` with the execution options): `{ input, ...namedGuardInputs, signal?, actor?, propagation?, traceAttributes? }`. Guards are declared through `GuardOptions`, shared by exposures and subscriptions. A field whose input is `void` may be left out. Unknown fields are rejected, and the request must be a plain object; each own field is read once.
- Guard names cannot be `input`, `signal`, `actor`, `propagation` or `traceAttributes`.
- `expose.compose({ getRole, renameRole })` groups exposures for one transport plug; each member stays independent.

### Listeners and schedulers

```ts
const onRoleChanged = listener<RoleEvent>()({
  requirements: { updateRoleProjection },
  run: (event, ctx) => ctx.updateRoleProjection(event),
});

const expireInvitations = scheduler({
  schedule: { every: { minutes: 5 } },
  overlap: "skip",
  requirements: { expireInvitationsCommand },
  run: (_input, ctx) => ctx.expireInvitationsCommand({ asOf: ctx.trigger.scheduledAt }),
});
```

A plug brings work in by calling `invoke`:

```ts
const invitationsTimer = plug({
  port: expireInvitations,
  requirements: { timerEngine },
  bind: async ({ timerEngine, port, invoke, signal }) => {
    const registration = await timerEngine.register({
      schedule: port.schedule,
      signal,
      onTick: (scheduledAt) => invoke({ trigger: { scheduledAt } }),
    });

    return { release: () => registration.stop() };
  },
});
```

- Listener triggers carry optional `messageId` and one-based `attempt`; scheduler triggers carry `scheduledAt` (`Timestamp`, epoch milliseconds). Listeners and schedulers take no guards.
- A schedule is an interval (`{ every: { milliseconds?, seconds?, minutes?, hours?, days? } }`) or `{ cron, timeZone }`; the driver implements it. No timer, cron engine or broker is bundled.
- `overlap: "skip"` (default) answers a tick that arrives while the previous one runs in this instance with `{ status: "skipped", reason: "overlap" }`; `"allow"` admits concurrent ticks. It is not a distributed lock.
- `bind()` receives `port`, `invoke`, its requirements and a source-lifetime `signal`, and returns `{ release() }`. Sources start after shared resources and before startup tasks, and stop after hosts during shutdown, draining what they admitted.

### Invokers

Plugs and transports receive invokers that resolve with the value and reject with the classified failure:

| Failure | Result |
| --- | --- |
| Returned authored failure | Retained with its identity, stack and cause |
| Cancellation of the execution's own signal | `InputCancelledError` |
| Classified error thrown again by nested work | Retained |
| A Flow error of another execution, via a plug | `InternalFlowError` with that error as cause |
| Any other throw, rejection or malformed Outcome | `InternalFlowError` with the original cause |
| Invocation after intake closed | `InputUnavailableError` |

Flow errors are functional `error()` factories; narrow `FlowExecutionError` (which also includes an operation's `InternalBehaviorError`) with `switch (error.type)` and check values with `InputCancelledError.is(value)`. Thrown errors never join inferred unions; `HandlerErrors` and `GuardErrors` name what a transport should expect. Invoker types are `ExecutionInvoker` and `InputInvoker<typeof port>`; request options are `ExecutionOptions`.

An invoker logs every failure it rejects with (see Execution logs), and the promise it returns is already handled: a plug awaits an invocation only to act on its result, as a broker's ack or reject, and its `catch` logs nothing again. Whatever fails before the plug calls `invoke`, such as decoding a message, never reached Flow; that code belongs to the plug, which logs its failure itself.

Each invocation opens a fresh scope. Flow checks cancellation before admission, between guards, before the handler and before every port call, so application code needs no checks; `ctx.signal` remains for native APIs. A supplied `signal` cancels the execution; each root execution's signal aborts when it completes.

## Outputs

```ts
import { deleted, reader } from "@openknot-ts/behavior";
import type { Deleted, Upserted } from "@openknot-ts/flow";
import { publisher, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { plug } from "@openknot-ts/wire";

const findRoleById = reader<(id: string) => Promise<Role | null>>();
const saveRole = writer<(role: Role) => Promise<Upserted<Role>>>();
const deleteRole = writer<(role: Role) => Promise<Deleted<Role>>>();
const roleEvents = publisher<RoleEvent>();

const roleWriters = plug({
  port: writer.compose({ saveRole, deleteRole }),
  requirements: { database },
  bind: ({ database }) => ({
    saveRole: async (role) => upserted(await database.roles.save(role)),
    deleteRole: async (role) => deleted(await database.roles.delete(role)),
  }),
});
```

- Readers and writers resolve to plain functions: `await ctx.saveRole(role)`. A publisher resolves to `{ publish(message, options?), publishNow(message, options?) }`.
- A plug takes one port or one `reader.compose`/`writer.compose`; `bind` returns one implementation per member. Separate plugs share resources through requirements.
- Bindings are built once per application while nothing they depend on is scoped or transient, otherwise once per scope.
- Plugs return data or throw; they never return Outcomes.

### Persistence results

`upserted(next)` returns `Upserted<State>` and Behavior's `deleted(previous)` returns `Deleted<Payload>`. The writer's author runs the query and checks its native result; Flow does not verify writes. `persist(output, { upsert, delete })` applies an operation output: `created`/`updated` upsert `next`, `deleted` deletes the full `previous`, `unchanged` writes nothing. A list of changes takes list writers such as `saveRoles(roles)`: one `upsert` call with every `next`, then one `delete` call with every `previous`, skipping a call with nothing to write. It returns the kept states in the list's order, without the deleted ones; the upsert writer returns one receipt per state, in order.

```ts
const result = await ctx.renameRoleOp(input);

if (result.isError) {
  return result;
}

const saved = await persist(result.value.output, { upsert: ctx.saveRole, delete: ctx.deleteRole });
```

### Managed receipts

A managed entity has an `entity` literal and a scalar `id`. Receipts of managed writers (single or arrays) join the Unit of Work's journal by `entity` + `id`; `latest(receipt)` returns the last one. Overlapping writes of the same unversioned entity fail. Versioned receipts are checked: an upsert returns `input.version + 1`, a deletion the input version; [`@openknot-ts/versioning`](../openknot-capabilities/versioning/README.md) supplies `VersionConflict`. A writer whose delete cascades returns a `deleted(state)` for every removed row.

`unitOfWorkChanges` from `/wire` tells read layers what a Unit of Work changed: `touched(result)`, `wrote(entity)`, `transaction()`, `afterCompletion(effect)` and `subscribe(listener)`. [`@openknot-ts/cache`](../openknot-capabilities/cache/README.md) and [`@openknot-ts/replication`](../openknot-capabilities/replication/README.md) use it.

## Unit of Work

Commands run `read-write` and queries `read-only` in `defaultUnitOfWork`, unless a handler declares `unitOfWork: anotherUow`. Nested calls join the same Unit of Work; a read-only one cannot be upgraded, and a nested failure marks it for rollback.

Without a binding, the default is a logical Unit of Work that stages work but has no storage transaction. Data access binds it with a plug, as [`@openknot-ts/drizzle-uow`](../openknot-plugs/drizzle/drizzle-uow/README.md) does:

```ts
plug({ port: defaultUnitOfWork, requirements: { transaction }, bind: ({ transaction }) => transaction });
```

```ts
const databaseUow = unitOfWork({ hooks: { afterCommit: [invalidate] } });

const change = command<Change>()({
  unitOfWork: databaseUow, // optional: otherwise the default
  requirements: { save, events },
  run: async (input, ctx) => {
    await ctx.save(input);
    ctx.uow.afterCommit(() => updateCache(input));
    await ctx.events.publish(input);
    return success();
  },
});
```

```text
run → beforeCommit → native commit → afterCommit hooks → read-layer changes → staged effects → publications → afterCompletion
```

- **Staging.** Inside a Unit of Work, `publish()` (publishers, topics, broadcasts) stages until commit; the outer call awaits delivery. `publishNow()` delivers at once and survives a later rollback. Rollback discards staged work.
- **Deferred messages.** `publish(({ latest }) => message | undefined)` runs once after commit and effects, with the Unit of Work's receipts.
- **Hooks.** `hook<UowCommitted>()({ requirements?, run })` in the `beforeCommit`, `afterCommit`, `afterRollback` and `afterCompletion` slots. A beforeCommit failure vetoes the commit as a `UnitOfWorkError`.
- **After commit**, every hook and effect runs even when one fails, and publications are delivered in order up to the first failure. Any failure is a `PostCommitError` with `committed: true` and its `phase`: `effects`, `changes`, `publications` or `completion`.
- **Uncertain outcomes** are a `UnitOfWorkError` with `transactionStatus: "unknown"`.
- **Nothing is interrupted** once the transaction ends; staged deliveries receive no cancellation signal.

A native implementation supplies `transaction(work, options: UnitOfWorkOptions)`: it binds its session, calls `work` once, resolves with its value only after commit, and rejects with its rejection only after rollback.

## Realtime contracts

```ts
import { broadcast, topic } from "@openknot-ts/flow";

const roles = topic<`roles:${string}`, RoleEvent>()({ guards: { authenticated } });
const logs = broadcast<LogEvent>()({ guards: { authenticated } });

await ctx.roles.publish("roles:one", roleEvent);
await ctx.logs.publish(logEvent);

const stream = await roles.subscribe({ input: "roles:one", authenticated: ctx.token, signal });
```

- `subscribe()` runs the guards in a short scope, then returns the implementation's `AsyncIterable` unchanged; a refused admission rejects like an exposure.
- Keys may be any type, including structured values; the implementation owns encoding and equality.
- A plug implements both operations:

```ts
const delivery = plug({
  port: roles,
  requirements: { events },
  bind: ({ events }) => ({
    publish: (key, event) => {
      events.emit(key, event);
    },
    subscribe: async function* (key, { signal }) {
      for await (const [event] of on(events, key, { signal })) {
        yield event as RoleEvent;
      }
    },
  }),
});
```

- `subscribe` always receives a `signal` (`SubscriptionOptions`) that aborts when the caller cancels or the application starts stopping; the implementation ends its stream on it.
- Flow adds no buffer, replay, registry or fan-out. [`@openknot-ts/knot-pubsub`](../openknot-plugs/knot/knot-pubsub/README.md) is a local implementation.

## Actors, tracing and logging

- **Actor.** Pass `actor` on an input request; handlers, guards and hooks read `ctx.actor`, and nested work keeps it. Type it once by augmenting `ExecutionTypes` with `readonly actor: AppActor`. Actors never propagate to publications or telemetry; put `createdBy` in events when needed.
- **Actor resolution.** `actorResolver({ requirements?, resolve(token, ctx) })` from `/wire` provides `executionActorResolver`, which transports consume, as [tRPC](../openknot-plugs/trpc/trpc-context/README.md) and [Auth0](../openknot-plugs/auth0/auth0-actor/README.md) do.
- **Tracing.** Flow consumes `optional(trace)` from [`@openknot-ts/tracing`](../openknot-capabilities/tracing/README.md). Every input, handler, guard, hook, Unit of Work, publication and subscription admission becomes a span named `openknot.<kind>`, with the definition's `tag` as `openknot.execution.tag`; listener deliveries and scheduler ticks are roots. Requests carry a `propagation` carrier (`PropagationCarrier`) and `traceAttributes`; native bindings receive the implementation as `invoke.tracing` and `PublishOptions.tracing`. Add [`provideOpenTelemetry()`](../openknot-plugs/opentelemetry/opentelemetry-tracing/README.md), or bind `trace` yourself. Native plugs trace their own operations with `withTrace()` from `@openknot-ts/tracing`.
- **Logging.** Flow definitions declare `logger` from [`@openknot-ts/logging/wire`](../openknot-capabilities/logging/README.md) in their requirements and log through `ctx.logger`. It writes on the console, filtered by `LOG_LEVEL`, until a plug such as [`providePinoLogging()`](../openknot-plugs/pino/pino-logging/README.md) provides `logging`.
- **Error reporting.** Every failure that ends an input, refused requests included, goes once to the application's [error reporter](../openknot-capabilities/error-reporting/README.md) when one is bound, such as Sentry, while the execution's span is active. Without a bound reporter nothing is reported.
- **Execution logs.** Flow logs its own executions per kind: `LOG_LEVEL_EXPOSE`, `LOG_LEVEL_LISTENER`, `LOG_LEVEL_SCHEDULER`, `LOG_LEVEL_SUBSCRIBE`, `LOG_LEVEL_COMMAND`, `LOG_LEVEL_QUERY`, `LOG_LEVEL_GUARD`, `LOG_LEVEL_HOOK`, `LOG_LEVEL_UNIT_OF_WORK` or `LOG_LEVEL_PUBLISH`. No failure is silent: every execution starts at an input, so exposures and subscriptions default to `error`, since they return failures to a caller whose transport reports a defect without logging it (tRPC answers 500), and listeners and schedulers default to `warn`, since no caller receives their failures at all; the other kinds are off until set. `off` leaves a kind unlogged. An input also logs a request it refuses before any execution runs, `not admitted` while the application stops or `failed` for an invalid request, and the promise its `invoke` returns is already handled: a plug that does not await an invocation, as `void invoke(request)`, can neither crash the process with an unhandled rejection nor lose a failure, while one that awaits still receives it. `trace` and `debug` write `started` and the end, `info` the end (`succeeded` or `failed`), `warn` only failures, `error` only defects; `fatal` writes nothing. A returned failure is written at `warn` with its `errorType`; an internal error at `error` with the error. A kind's level replaces `LOG_LEVEL` for these records, so `LOG_LEVEL_COMMAND=debug` works with `LOG_LEVEL=info`. `LOG_DURATION=true` adds `durationMs`, measured with `performance.now()`. Records carry `kind` and `tag`, never inputs, outputs or actors; a kind that is off runs without a wrapper.

  ```text
  LOG_LEVEL_COMMAND=info LOG_DURATION=true
  2026-11-11T19:40:00.000Z INFO command role.rename succeeded { kind: 'command', tag: 'role.rename', durationMs: 1.42 }
  ```

## Provision

An application lists its input ports, or their compositions, in `defineApplication({ inputs })`; everything they need is followed through requirements:

```ts
const application = defineApplication({
  inputs: [roleApi, onRoleChanged],
  modules: [roleStorage, roleEventsBus, http],
});
```

A package can also publish its ports as a ready module:

```ts
import { provideFlow } from "@openknot-ts/flow/wire";

// Leave the type inferred: it carries the graph the compile-time check reads.
export const flow = provideFlow([roleApi, onRoleChanged, roleReaders, roleWriters]);
```

| Direction | Ports |
| --- | --- |
| Input | `expose`, `listener`, `scheduler`, `topic`, `broadcast` |
| Output | `reader`, `writer`, `publisher` |

Sources are those ports, their compositions, native `unit()`s, namespaces and import loaders with literal specifiers. Handlers, guards, hooks and operations join through `requirements` and are rejected as sources. Plugs belong in `providePlugs()` modules. Input plugs in root modules start automatically; `includeOnly([])` suppresses them.

`transactional()` from `/wire` marks a publisher implementation whose publications are sent inside the transaction, at the end of beforeCommit, as [`@openknot-ts/outbox`](../openknot-capabilities/outbox/README.md) does.

The [quick-start](../example/quick-start/README.md) and [modular](../example/modular/README.md) examples use these primitives in one small application.
