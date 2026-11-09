# PostgreSQL plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output.

| Package | Responsibility |
| --- | --- |
| [`@openknot-ts/postgres-client`](postgres-client/README.md) | A native node-postgres pool as a Wire resource, with a health check |

Database access through Drizzle lives in [`../drizzle`](../drizzle/README.md): `drizzle-uow` takes the pool's Drizzle database, and `@openknot-ts/drizzle-outbox/pg` stores outbox records in its transaction.
