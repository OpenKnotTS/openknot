# @openknot-ts/behavior

Pure business logic: models, operations, reader contracts and functional errors. No container, reflection, decorators or code generation. `@openknot-ts/wire` is a required peer whose small helpers the root entry shares without loading the container; `/wire` adds DI provision.

```sh
pnpm build
pnpm --filter @openknot-ts/behavior test
pnpm --filter @openknot-ts/behavior example       # examples/roles.ts, standalone
pnpm --filter @openknot-ts/behavior example:wire  # examples/wired-roles.ts, with DI
```

## Models

A model owns state and its rules. With a [Standard Schema](https://standardschema.dev/schema), the state is inferred from it:

```ts
import { model, success } from "@openknot-ts/behavior";
import { z } from "zod";

const roleNameSchema = z.string().trim().min(1);

const roleSchema = z
  .object({
    id: z.string().min(1),
    name: roleNameSchema,
  })
  .readonly();

type RoleState = z.infer<typeof roleSchema>;

export const Role = model({
  name: "role",
  invariants: roleSchema,
  mutations: {
    rename: (role: RoleState, name: string) => success({ ...role, name }),
  },
  queries: {
    isNameValid: (name: string) => roleNameSchema.safeParse(name).success,
    displayName: (role: RoleState) => role.name,
  },
});
```

Without a schema, declare the state on the head: `model<State>()({ mutations, queries?, invariants? })`.

- **Mutations** return `Outcome<State, E>`. Every successful result is validated through the schema's `~standard.validate()`; the parsed value (normalized, transformed) becomes the state. Failures return `ModelValidationError` with standard `issues`. Declared mutation failures skip validation.
- Behavior depends only on the `StandardSchemaV1` type from `@standard-schema/spec`; the schema library is the application's.
- **`invariants`** is a schema or a synchronous `(state) => Outcome<void, E>` whose errors join every mutation's result.
- **Queries** are synchronous pure functions with their own arguments and return types; they do not run invariants.
- Mutations and queries are called directly on the model, `Role.rename(role, name)`, share one namespace and must be synchronous. `name` is an optional diagnostic label.
- Models are plain public exports: no registration. The schema stays an ordinary export that fixture loaders and boundaries reuse.

## Operations

An operation computes a business change: it reads through reader contracts, applies rules that need dependencies (such as uniqueness), calls model mutations and declares events.

```ts
import type { Event } from "@openknot-ts/behavior";
import { operation, success, unchanged, updated } from "@openknot-ts/behavior";

type RoleEvent = Event &
  (
    | { readonly type: "RoleCreated"; readonly roleId: string }
    | { readonly type: "RoleRenamed"; readonly roleId: string }
  );

const renameRole = operation<{ readonly role: RoleState; readonly name: string }, RoleState, RoleEvent>()({
  run: ({ role, name }) => {
    const renamed = Role.rename(role, name);

    if (renamed.isError) {
      return renamed;
    }

    if (renamed.value.name === role.name) {
      return success({ output: unchanged(role), events: [] });
    }

    return success({
      output: updated(renamed.value),
      events: [{ type: "RoleRenamed" as const, roleId: role.id }],
    });
  },
});
```

`operation<Input, State, Event>()({ requirements?, run, tag? })`: types go on the head, so the definition reads like a signature; requirements and errors are inferred. `State` and `Event` are optional. With nothing to declare, `operation({ ... })` takes no input.

### Outputs

Every success carries a fixed `output`, built with a helper:

| Helper | Descriptor |
| --- | --- |
| `created(state)` | `{ changeType: "created", next: state }` |
| `updated(state)` | `{ changeType: "updated", next: state }` |
| `deleted(state)` | `{ changeType: "deleted", previous: state }` |
| `unchanged(state)` | `{ changeType: "unchanged", current: state }` |

The type is `OperationOutput<State>`; `Deleted<Payload>` names a deletion result and also types persistence writers. Helpers freeze their own wrapper and keep the state by reference.

One decision that changes several states of the same model returns a list, each change with its own type, for example `output: [updated(kept), deleted(merged)]`. An empty list means nothing changed.

### Events

- With an `Event` type, `run` returns `events: readonly Event[]` (`[]` when none). Without one, results have no `events` property and authoring rejects them.
- `unchanged` results, and lists of only `unchanged` results or no results, must carry an empty event array.
- `Event` is a types-only `{ readonly type: string }`. Name each model's union `<ModelName>Event`, such as `RoleEvent`, with a variant per `type`, for example `interface RoleRenamed extends Event<"RoleRenamed"> { readonly role: RoleState }`.
- Child operations in `ctx` return their own results; their events are never merged automatically.

The operation decides no-ops: the framework never compares states. Flow persists and publishes; an operation performs no infrastructure effects besides logging through `logger` from [`@openknot-ts/logging/wire`](../openknot-capabilities/logging/README.md), which never changes its outcome.

### Derived types

```ts
import type { OperationErrors, OperationEvents, OperationInput } from "@openknot-ts/behavior";

type RenameRequest = OperationInput<typeof renameRole>;
type AllowedEvents = OperationEvents<typeof renameRole>; // RoleEvent, or never without an event type
type RenameErrors = OperationErrors<typeof renameRole>; // the authored errors
```

A Flow command can declare its input as `command<OperationInput<typeof renameRole>>()`.

## Errors

```ts
export const AccessDenied = error("AccessDenied");
export const RoleNotFound = error("RoleNotFound", (id: string) => ({ message: `Role ${id} was not found`, id }));

failure(RoleNotFound("r1"));
```

- Each call creates a frozen `Error` with a literal `type`, message, optional cause and the caller's stack. A describer cannot return `name`, `stack` or `type`.
- Check with `switch (error.type)` or `RoleNotFound.is(value)`, never `instanceof`.
- Name the type only where needed: `type RoleNotFound = ReturnType<typeof RoleNotFound>`. Packages that publish declarations use `interface RoleNotFound extends ReturnType<typeof RoleNotFound> {}`.
- Return expected failures with `failure(error)`. Anything thrown, or rejected, inside an operation, reader call, mutation or invariant is thrown as `InternalBehaviorError` with the original `cause`; it never joins an inferred error union.
- Detached promises and timers are outside the boundary.

## Readers

`reader<F>()` declares a contract; the resolved reader is the bound function. Identity is the reference, not the name or signature. `reader.compose({ findRole, listRoles })` groups readers for one plug; each stays independently injectable. A managed entity is a state with an `entity` literal (the model name) and a scalar `id`; Flow's managed writers track it, plain states are never tracked.

Infrastructure implements readers with `plug()` from `@openknot-ts/wire` (typed by `@openknot-ts/behavior/wire`):

```ts
plug({ port: reader.compose({ findRole, listRoles }), requirements: { database }, bind: ({ database }) => ({ findRole, listRoles }) });
```

Caching stays outside Behavior: [`@openknot-ts/cache`](../openknot-capabilities/cache/README.md) and [`@openknot-ts/replication`](../openknot-capabilities/replication/README.md) decorate readers.

## Running without an application

`standalone(operation, overrides?)` runs an operation with explicitly supplied readers, for scripts and tests. Missing or duplicate readers and cycles fail before execution. A required `logger` writes on the console unless `override(logger, value)` supplies one.

```ts
import { operation, reader, standalone, success, updated } from "@openknot-ts/behavior";
import { override } from "@openknot-ts/wire";

const currentCount = reader<(id: string) => Promise<number>>();

const incrementCounter = operation<string>()({
  requirements: { currentCount },
  run: async (id, ctx) => success({ output: updated((await ctx.currentCount(id)) + 1) }),
});

const runIncrement = standalone(incrementCounter, [override(currentCount, () => Promise.resolve(3))]);
const result = await runIncrement("counter-1");
```

Resolved operations always return a Promise of an Outcome.

## Provision with Wire

A package index publishes its operations with `provideBehavior()` from `@openknot-ts/behavior/wire`:

```ts
import { provideBehavior } from "@openknot-ts/behavior/wire";
import { roleOperations } from "./operations/roles.ts";

// Leave the type inferred: it carries the graph the compile-time check reads.
export const behavior = provideBehavior([roleOperations]);
```

- Sources are operations, `operation.compose({ renameRole, deactivateRole })` groups, native Wire `unit()`s, namespaces and import loaders with literal specifiers, such as `() => import("./role.operations.ts")`. Models, readers, resources and plugs are rejected.
- Readers and private child operations join through `requirements`; operations may require only readers, operations and `logger`.
- Operations need no module of their own in an application: its `inputs` reach them through requirements. A provided module can still be listed in `defineApplication({ modules })`, where `includeOnly`, `exclude`, `when` and `requiredBy` select from it.
- Operations and readers are scoped: resolve them inside `app.withScope(work, { root: operation })`, which acquires only what that operation can reach. Missing implementations fail at `runApplication()`.

```ts
const behavior = provideBehavior([increment]);

const storage = composeModule({
  providers: {
    countBinding: plug({ port: currentCount, bind: () => () => Promise.resolve(3) }),
  },
});

const app = await runApplication(defineApplication({ modules: storage.requiredBy(behavior) }));

try {
  console.log(await app.withScope((scope) => scope.resolve(increment)(), { root: increment }));
} finally {
  await app.stop();
}
```

[test/composition-types.ts](test/composition-types.ts) checks allowed sources and inferred signatures. The [quick-start](../example/quick-start/README.md) and [modular](../example/modular/README.md) examples use this package in a complete application.
