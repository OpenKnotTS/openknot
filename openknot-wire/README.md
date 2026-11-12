# @openknot-ts/wire

Functional dependency injection and application lifecycle, with no third-party runtime dependency. Modules are composed with ordinary imports, dependencies are explicit `requirements` with inferred types, and values are keyed by definition identity, never by strings. No decorators, scanning, code generation or compiler plugins.

```sh
pnpm build
pnpm --filter @openknot-ts/wire test
pnpm --filter @openknot-ts/wire example   # examples/role-api
```

## Quick start

```ts
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";

const roleRepository = unit({ factory: () => ({ find: (id: string) => id }) });

const roleService = unit({
  requirements: { repository: roleRepository },
  factory: ({ repository }) => ({ find: repository.find }),
});

const repositories = composeModule({ providers: { roleRepository } });
const services = composeModule({ providers: { roleService } });

const app = await runApplication(
  defineApplication({ modules: repositories.requiredBy(services.includeOnly([roleService])) }),
);

try {
  console.log(app.resolve(roleService).find("r1"));
} finally {
  await app.stop();
}
```

## Providers

| Provider | Action | Lifetimes |
| --- | --- | --- |
| `unit({ requirements?, factory, lifetime?, provides?, whenAvailable? })` | `factory(dependencies)` builds a value synchronously. | `singleton` (default), `scoped`, `transient` |
| `resource({ requirements?, initialize, lifetime? })` | `initialize(dependencies, { signal })` acquires a value and returns `{ value, release }`. | `singleton`, `scoped` |
| `hook({ requirements?, run })` | `run(dependencies, { signal })` performs a lifecycle step. | selected as a startup or shutdown task |
| `config({ VARIABLE: schemaOrParse })` | Validated environment variables. | singleton |
| `unit.contract<T>({ lifetime? })` | A reference without an implementation. | |
| `collect.contract<T>()` | A collection that units join through `provides`. | singleton |

`requirements` is a named object of references. The factory receives an immutable snapshot of the resolved values, typed from the references; omitting it gives an empty context. `optional(reference)` consumes a reference only when it has an implementation, as `Resolved<typeof reference> | undefined`, without adding it to the graph. A requirement cannot be named `__proto__`.

`Resolved<P>`, `ProviderDependencies<P>` and `ProviderArguments<P>` describe a provider's value and context.

### Lifetimes

- **singleton**: one per application, built at startup after resources and before intake.
- **scoped**: one per execution scope; resolve it inside `app.withScope()`.
- **transient**: rebuilt on every resolution and owned by its consumer.

A singleton cannot capture a scoped value, directly, through a decoration or through a chain of transients; this fails at startup with the requirement path. Deferred execution references capture nothing.

## Modules

```ts
import * as roleProviders from "./role.providers.ts";

const roles = composeModule({ providers: roleProviders });
const together = composeModule({ modules: [repositories, roles] });
```

| Selector | Effect |
| --- | --- |
| `module.includeOnly([provider])` | Selects roots; the rest stays available for resolution. |
| `requiredBy(module)`, `dependencies.requiredBy(module)` | Activates a module's roots; the dependency module only supplies definitions. |
| `module.exclude([provider or module])`, `module.when(false)` | Application-wide hard exclusion. |

Units, collections and listed resources are roots by default. Definitions reached through requirements need no module. Views are immutable, and a module is materialized once per application.

### Applications

An application names its input ports and the implementations it selects:

```ts
const application = defineApplication({
  inputs: [roleApi, onRoleChanged],
  modules: [roleStorage, eventBus, http],
});
```

- `inputs` are the application's roots: ports such as exposures and listeners, or their compositions (`expose.compose({ ... })`), whose members are listed. What they need is followed through requirements. Only input ports are accepted: a handler, guard or plug listed there fails to compile and is rejected by `defineApplication()`, since layers mark their input ports with Wire's input marker.
- `modules` lists modules, or definitions directly: plugs, resources, units, decorations. Their order is the module order, which orders collection members and intake.
- Implementations are never found by scanning: an application selects them, so two applications, or a test, can choose different ones.

Packages can still publish ready modules with `provideBehavior()`, `provideFlow()` and `providePlugs()`. Leave module exports inferred: an annotation such as `: ProvidedFlow` erases the graph that compile-time checks read.

## Contracts and bindings

```ts
const logger = unit.contract<(message: string) => void>();
const nativeLogger = unit({ factory: () => console.log });

const logging = unit({
  provides: logger,
  requirements: { nativeLogger },
  whenAvailable: true,
  factory: ({ nativeLogger }) => nativeLogger,
});

const service = unit({
  requirements: { logger: optional(logger) },
  factory:
    ({ logger }) =>
    () =>
      logger?.("started"),
});
```

- **`provides: reference`** makes a provider the implementation of a contract, an integration's reference (such as a reader or Unit of Work) or an ordinary provider. A reference's own declaration is its default: one binding replaces it, a contract has none, two bindings fail. To replace a binding, exclude it and list another.
- **`whenAvailable: true`** binds only when every non-optional requirement is registered; `whenAvailable: [references]` checks those references instead. Conditions are evaluated once against the graph, never by calling factories.
- **Collections**: units that `provides: collection` join it in module order (only those the root modules list). The contract resolves to a frozen array, empty without members.

```ts
export const healthChecks = collect.contract<() => Promise<"up" | "down">>();

export const databaseCheck = unit({
  provides: healthChecks,
  requirements: { database },
  factory: ({ database }) => async () => ((await database.ping()) ? "up" : "down"),
});
```

## Decorations

`decorate(target, { requirements?, wrap })` wraps an existing implementation: retries, metrics, caching, spies.

```ts
const traced = decorate(findRole, {
  requirements: { metrics },
  wrap:
    (inner, { metrics }) =>
    (id) =>
      metrics.time(() => inner(id)),
});
```

Modules list decorations; the first listed for a target is innermost. A decoration inherits the target's lifetime; an override stays final. Only unit-backed definitions (including Behavior and Flow contracts) can be decorated.

## Plugs

`plug({ port, requirements?, bind })` implements a port that an integration owns, such as a Behavior reader or a Flow writer, publisher or listener:

```ts
import type {} from "@openknot-ts/flow/wire";
import { plug, providePlugs } from "@openknot-ts/wire";

const storage = plug({
  port: saveRole,
  requirements: { database },
  bind:
    ({ database }) =>
    (role) =>
      database.save(role),
});

export const io = providePlugs([database, transaction, storage]);
```

A plug takes one port or one composition (`reader.compose({ ... })`), whose `bind` returns one implementation per member. Output bindings return the implementation; input bindings may be asynchronous and return a `PlugHandle` (`{ release() }`). `providePlugs()` accepts plugs, units, resources and decorations.

## Configuration

`config()` declares the variables a plug reads, by their real names, as Standard Schemas or parse functions:

```ts
export const httpConfig = config({
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  HTTP_HOST: (value = "127.0.0.1") => value,
});
```

- `runApplication()` validates every config a registered definition may resolve, a definition outside the selected roots included, from `process.env`, or from `{ env }`, before any resource starts. All invalid variables are reported together, by name and without their values.
- Each variable has one owning config; two owners fail startup.
- `describeApplication()` lists the variables the application reads. Load `.env` files with `node --env-file-if-exists=.env`.
- Never supply settings through `override()`.

## Running an application

```ts
const app = await runApplication(application, { env, overrides, signal, stopOn });
await app.stopped;
```

`RunApplicationOptions`:

| Option | Description |
| --- | --- |
| `env` | Environment values instead of `process.env`. |
| `overrides` | `override(reference, value)`: ready values that skip construction; Wire never releases them. |
| `signal` | Bounds the application: aborting during startup unwinds, aborting later calls `app.stop()`. |
| `stopOn` | Process signals that stop it; `["SIGINT", "SIGTERM"]` by default, such as `["SIGTERM", "SIGHUP"]`, or `[]` to leave signals to the host. A signal-initiated stop exits with status 0. |

The `Application` has `resolve(reference)`, `withScope(work, options?)`, `stop()`, `stopped`, `ready` and `status`.

`defineApplication({ inputs?, modules?, startupTasks?, shutdownTasks?, resourceOrder? })` also selects hooks for each phase and resources that must open first:

```ts
const application = defineApplication({
  inputs: [roleApi],
  modules: [observability, io, channels],
  startupTasks: [warmCache],
  shutdownTasks: [recordShutdown],
  resourceOrder: [telemetry],
});
```

### Startup

1. Validate the graph and the configuration.
2. Acquire reachable resources in parallel, each after those it depends on (`resourceOrder` first, one by one). The first failure aborts the others through their signal and releases what was acquired.
3. Build reachable singletons.
4. Open the intake: sources (such as Flow's listeners) then hosts (such as an HTTP server reaching Flow exposures), each in module order.
5. Run startup tasks in order, then become `ready`.

A resource's `initialize` and a startup task receive the startup's cancellation `signal`; pass it to native acquisitions. Unreachable, catalogue-only and overridden resources are not acquired.

### Intake

A resource that brings work in needs no declaration. An integration marks its inputs `source: true`; any other singleton resource whose construction reaches a definition with `opensScope: true` is a host. A server is an ordinary resource:

```ts
export const httpServer = resource({
  requirements: { httpConfig, router },
  async initialize({ httpConfig, router }, { signal }) {
    const server = createServer(router);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject).listen({ port: httpConfig.PORT, host: httpConfig.HTTP_HOST, signal }, resolve);
    });

    return {
      value: { url: `http://${httpConfig.HTTP_HOST}:${(server.address() as AddressInfo).port}` },
      release: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
  },
});
```

Hosts listen before startup tasks run, while readiness stays down; put prerequisites such as migrations in resources.

### Shutdown

`stop()` clears readiness, runs shutdown tasks in order, closes intake in reverse (hosts, then sources, so a draining request can still publish), drains active scopes, then releases resources in reverse. Every step is attempted after failures, which are reported together. A failed startup unwinds the same way; a failed resource acquisition runs no hooks.

## Execution scopes

```ts
await app.withScope(
  async (scope) => {
    await scope.resolve(requestHandler)(input);
  },
  { root: requestHandler },
);
```

| Option | Effect |
| --- | --- |
| none | Acquires every reachable scoped resource. |
| `{ root }` | Acquires only the scoped resources that root can reach, including its deferred references. |
| `{ resources: [...] }` | Acquires exactly those (and what they depend on); `[]` acquires none. Exclusive with `root`. |
| `{ signal }` | Cancels the scope's acquisitions. |

Scoped values are shared within the callback and released after it, even on failure. Await all scoped work inside the callback.

## Validation

`runApplication()` rejects, before any resource initializes and all together:

- a reachable contract without an implementation, or an excluded dependency, with its requirement path, such as `reader 'find' has no implementation (expose → handler → check → find)`;
- multiple implementations, cycles and lifetime violations;
- duplicate overrides, misplaced hooks and decorations without a target.

The compiler also reports missing implementations at `runApplication()`, derived from the final graph:

```
runApplication(defineApplication({ inputs: [roleApi], modules: [io, transport] }));
// … required in type '{ readonly missingImplementations: "logPublisher" | "rolePublisher"; }'
```

Startup validation stays the complete check: same-signature contracts are one structural type, and lifetimes and cycles are checked only at startup.

## Application status and connections

- `applicationStatus` resolves to `() => ApplicationStatus`: `starting`, `ready`, `stopping` (synchronously inside `stop()`), `stopped`. Each application has its own; [`@openknot-ts/health`](../openknot-capabilities/health/README.md) builds on it.
- `ConnectionWatch` reports a native connection's outages: `watch({ lost, restored })` returns an unsubscribe. Plugs build one with `connectionWatch(attach)`, which attaches to the client with the first watcher, detaches with the last and reports each outage once. Examples: `@openknot-ts/redis-client`'s `connection` and `@openknot-ts/rabbitmq`'s `rabbitConnection`; the cache, replication and outbox accept one.

## Introspection

`describeApplication(definition, { overrides? })` returns the composed graph as plain data, without starting anything:

```ts
const { definitions, problems } = await describeApplication(application);
// { id: 9, kind: "writer", lifetime: "scoped", binding: "implementation", names: ["saveRoleWriter"],
//   dependencies: [{ name: "outputAdapter", id: 14, optional: false }], references: [], decorations: [], roles: [] }
```

`binding` is `implementation`, `unbound` or `override`. Roles are `root`, `resource`, `intake`, `scope-resource`, `startup-task` and `shutdown-task`. Validation problems are listed instead of thrown.

## Testing

```ts
const app = await runApplication(definition, {
  env: { PORT: "0" },
  overrides: [override(database, databaseStub)],
});
```

To use another implementation, list a binding with `provides` for the same reference and exclude the default one. Applications in one process stay isolated.

## Extending Wire

A primitive is a function that returns a `unit`, `resource` or `plug`, as `healthCheck()` and `trpcRouter()` do:

```ts
export const jobs = collect.contract<Job>();

export function job<const R extends Requirements = NoRequirements>(
  options: RequirementsOptions<R> & {
    readonly name: string;
    readonly run: (dependencies: ResolvedReferences<R>) => Promise<void>;
  },
) {
  const { name, run } = options;

  return unit({
    requirements: options.requirements as R,
    provides: jobs,
    factory: (dependencies) => ({ name, run: () => run(dependencies as ResolvedReferences<R>) }),
  });
}
```

A whole layer, such as Behavior or Flow, is an integration. Its definitions carry a `DefinitionIntegrationMarker` whose `load()` returns a `DefinitionAdapter`; Wire loads it when a module or requirement reaches such a definition. An adapter returns `AdaptedDefinition`s: a provider and canonical `reference`, deferred `references`, `opensScope`, `pure` (built once per application when nothing it depends on is scoped or transient), `source` and additional `provides`. It receives a `DefinitionAdapterContext` with the application status, the `stopping` signal, `intakeOpen` and `withScope`. Integrations augment the open `DefinitionTypes`, `DefinitionResults<D>`, `PlugFactory`, `ContractKinds`, `ImplementedContracts` and `DependencyFields` interfaces for typing. Wire imports no layer.

The [quick-start](../example/quick-start/README.md) and [modular](../example/modular/README.md) examples compose a complete application.
