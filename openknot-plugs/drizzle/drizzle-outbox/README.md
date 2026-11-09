# @openknot-ts/drizzle-outbox

Implements the [`@openknot-ts/outbox`](../../../openknot-capabilities/outbox/README.md) store over Drizzle. Records are saved in the transaction of the application's [`drizzleUnitOfWork()`](../drizzle-uow/README.md), so a change and its publications commit or roll back together.

## Usage

```ts
import { drizzleOutbox, outboxTable } from "@openknot-ts/drizzle-outbox/sqlite";

export const io = providePlugs([roleReaders, roleWriters, drizzleOutbox({ transaction })]);
// schema: export { outboxTable } so the application's migrations create `openknot_outbox`
```

## API

`@openknot-ts/drizzle-outbox/sqlite` and `@openknot-ts/drizzle-outbox/pg` each export:

| Export | Description |
| --- | --- |
| `drizzleOutbox({ transaction, requirements?, leaseMs? })` | The store. `transaction` is the application's `drizzleUnitOfWork()` unit; `leaseMs` is a number or `(dependencies) => number`, default 30 seconds. |
| `outboxTable` | The table definition for the application's schema. |

A PostgreSQL pool comes from [`@openknot-ts/postgres-client`](../../postgres/postgres-client/README.md).

## Behavior

- A publication outside the Unit of Work's transaction fails. Delivery runs outside any transaction.
- A claim is one `UPDATE … RETURNING`: the oldest records of a name for one owner, unless another owner holds an unexpired claim. Leases follow the database clock.
- Before each send the dispatcher renews its claim, which also tells it whether another owner took over.
- Delivered records are deleted; undelivered ones keep their attempt count and last error.

## Example and tests

`pnpm --filter @openknot-ts/drizzle-outbox example` runs [examples/outbox.ts](examples/outbox.ts): a role and its event committed to SQLite, delivered with its `messageId`.

[test/sqlite.test.ts](test/sqlite.test.ts) covers atomic commits, rollbacks, publications outside the transaction, claims, leases and order. [test/postgres.integration.ts](test/postgres.integration.ts) covers PostgreSQL with four concurrent owners:

```sh
DATABASE_URL=postgres://user:password@localhost:5432/db pnpm --filter @openknot-ts/drizzle-outbox test:postgres
```
