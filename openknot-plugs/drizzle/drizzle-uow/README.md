# @openknot-ts/drizzle-uow

Implements Flow's Unit of Work over native asynchronous Drizzle transactions. The first database access in a Unit of Work opens its transaction, which readers and writers share through an async context. The application owns the database and its driver; supported are Drizzle's asynchronous SQLite, PostgreSQL and MySQL databases.

## Usage

```ts
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import { defaultUnitOfWork } from "@openknot-ts/flow";
import "@openknot-ts/flow/wire";
import { plug, unit } from "@openknot-ts/wire";

const transaction = unit({
  requirements: { database },
  factory: ({ database }) => drizzleUnitOfWork({ database }),
});

const unitOfWorkBinding = plug({
  port: defaultUnitOfWork,
  requirements: { transaction },
  bind: ({ transaction }) => transaction,
});

const saveRoleBinding = plug({
  port: saveRoleWriter,
  requirements: { transaction },
  bind:
    ({ transaction }) =>
    async (role) => {
      await (await transaction.current()).insert(roles).values(role);
    },
});

const listRolesBinding = plug({
  port: listRoles,
  requirements: { transaction },
  bind:
    ({ transaction }) =>
    async () =>
      (await transaction.current()).select().from(roles),
});
```

`database` is an ordinary Wire resource. The [quick-start](../../../example/quick-start/src/plugs/io/drizzle.ts) and [modular](../../../example/modular/plugs/io/src/drizzle.ts) examples show complete bindings.

## API

| Member | Description |
| --- | --- |
| `drizzleUnitOfWork({ database, transactionConfig? })` | The Unit of Work implementation. `transactionConfig(options)` maps Flow's mode, signal and metadata to the driver's native transaction config. |
| `await transaction.current()` | The native transaction inside a Unit of Work (opening it on first use), the database outside one. Read it when executing a query, not at construction. |
| `transaction.session` | The opened transaction, or `undefined` before the first `current()`. |

## Behavior

```text
handler → first transaction.current(): BEGIN → beforeCommit hooks → COMMIT
        → afterCommit hooks → staged effects → staged publications → afterCompletion hooks
```

- Work that never calls `current()` opens no transaction and holds no connection.
- Commit and rollback are `database.transaction()`'s. Rollback discards effects and publications; a failure after commit keeps the writes and is reported as `PostCommitError`.
- Cancellation is checked before the work and before opening the transaction; in-flight SQL is not interrupted.
- Synchronous drivers are rejected; the driver must await the callback and resolve after commit.
- Flow's read-only mode prevents nested commands; database-level read-only needs driver support.

The catalog pins `drizzle-orm` `1.0.0-rc.5`. See [Drizzle transactions](https://orm.drizzle.team/docs/transactions) for backend options.

## Tests

```sh
pnpm --filter @openknot-ts/drizzle-uow test
```

Real libSQL transactions: lazy opening, commit and rollback, nested sessions, after-commit ordering, cancellation, async-context isolation and read-layer recovery.
