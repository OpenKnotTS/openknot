# OpenTelemetry plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output. Plugs over the application's OpenTelemetry SDK, through the standard API.

| Package                                                              | Responsibility                             |
| -------------------------------------------------------------------- | ------------------------------------------ |
| [`@openknot-ts/opentelemetry-tracing`](opentelemetry-tracing/README.md) | Execution tracing and propagation for Flow |

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
