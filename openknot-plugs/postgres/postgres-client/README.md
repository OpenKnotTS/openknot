# @openknot-ts/postgres-client

Manages an application-created node-postgres `pg.Pool` as a Wire resource, with a health check.

## Usage

```ts
import { postgresClient, postgresHealthCheck } from "@openknot-ts/postgres-client";
import { config } from "@openknot-ts/wire";
import pg from "pg";

const settings = config({ DATABASE_URL: z.string().url() });

export const postgres = postgresClient({
  requirements: { settings },
  create: ({ settings }) =>
    new pg.Pool({ connectionString: settings.DATABASE_URL, connectionTimeoutMillis: 5_000 }).on("error", report),
});

export const transaction = unit({
  requirements: { postgres },
  factory: ({ postgres }) => drizzleUnitOfWork({ database: drizzle({ client: postgres }) }),
});

export const io = providePlugs([postgres, postgresHealthCheck({ postgres }), transaction /* readers, writers */]);
```

## API

| Export | Description |
| --- | --- |
| `postgresClient({ requirements?, create })` | The pool as a resource. Resolves to the native pool, for direct use or Drizzle ([`drizzle-uow`](../../drizzle/drizzle-uow/README.md), [`@openknot-ts/drizzle-outbox/pg`](../../drizzle/drizzle-outbox/README.md)). |
| `postgresHealthCheck({ postgres, name?, timeoutMs? })` | `SELECT 1` within the check's deadline (one second by default). |

## Lifecycle

- `create` chooses the pool's settings. Attach an `error` listener there: an unhandled idle-client error ends the process.
- Acquisition checks out one connection, so an unreachable server or bad credentials fail startup.
- A failed or cancelled startup ends the pool. node-postgres cannot cancel a connection attempt, so set `connectionTimeoutMillis` to bound every attempt.
- Release ends the pool once and completes only when every connection has closed its socket.

## Tests

[test/client.test.ts](test/client.test.ts) covers refused and cancelled startups. [test/postgres.integration.ts](test/postgres.integration.ts) runs against a real server:

```sh
DATABASE_URL=postgres://user:password@localhost:5432/db pnpm --filter @openknot-ts/postgres-client test:postgres
```
