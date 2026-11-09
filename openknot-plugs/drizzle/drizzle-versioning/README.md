# @openknot-ts/drizzle-versioning

Implements the [versioning contract](../../../openknot-capabilities/versioning/README.md) over a native asynchronous SQLite or PostgreSQL Drizzle session.

## Usage

```ts
import { drizzleVersioning } from "@openknot-ts/drizzle-versioning";
import type {} from "@openknot-ts/drizzle-versioning/wire";
import { versioningOf } from "@openknot-ts/versioning";
import { versioning } from "@openknot-ts/versioning/wire";

export const rowVersioning = unit({
  provides: versioning,
  requirements: { transaction },
  factory: ({ transaction }) => versioningOf(drizzleVersioning(transaction)),
});
```

`drizzleVersioning(transaction)` takes any object whose `current()` returns the session, such as [`@openknot-ts/drizzle-uow`](../drizzle-uow/README.md)'s.

## Behavior

- Tables need `id` and `version` columns and must match the session's dialect.
- Inserts write version 1; updates and deletes match the expected version and return the changed row. No changed row is a `VersionConflict`.

## Example and tests

`pnpm --filter @openknot-ts/drizzle-versioning example` runs [examples/sqlite.ts](examples/sqlite.ts): versioned saves and a rejected stale write. [test/postgres.integration.ts](test/postgres.integration.ts) runs against a real server with `env DATABASE_URL=postgres://… pnpm --filter @openknot-ts/drizzle-versioning test:postgres`.
