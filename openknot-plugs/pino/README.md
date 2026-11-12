# Pino plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output. Plugs over the application's pino instance.

| Package                                              | Responsibility                           |
| ---------------------------------------------------- | ---------------------------------------- |
| [`@openknot-ts/pino-logging`](pino-logging/README.md) | OpenKnot logging records written by pino |

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
