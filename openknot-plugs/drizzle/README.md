# Drizzle plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output. Plugs over an application-provided Drizzle database.

| Package                                                        | Responsibility                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`@openknot-ts/drizzle-uow`](drizzle-uow/README.md)               | Native transactions for the Unit of Work, with sessions shared by IO |
| [`@openknot-ts/drizzle-versioning`](drizzle-versioning/README.md) | Versioned insert, update and delete for the versioning contract      |
| [`@openknot-ts/drizzle-outbox`](drizzle-outbox/README.md) | Outbox records in the Unit of Work transaction, with lease claims, for SQLite and PostgreSQL |

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
