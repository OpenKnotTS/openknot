# Capabilities

This folder groups independent workspace packages. It has no package manifest, entry point or build output. Optional framework capabilities: each owns a framework contract and its semantics, and joins an application only when an implementation or module is selected.

| Package                                          | Contract                                         | Responsibility                                    |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------- |
| [`@openknot-ts/health`](health/README.md)           | Probes over Wire's `applicationStatus`           | Lifecycle-bound liveness, readiness and health    |
| [`@openknot-ts/tracing`](tracing/README.md)         | Neutral spans, carriers and `trace`              | OpenKnot's own tracing API                        |
| [`@openknot-ts/logging`](logging/README.md)         | `logger` over a `Logging` implementation         | Leveled logs, written on the console by default   |
| [`@openknot-ts/error-reporting`](error-reporting/README.md) | `errorReporter`, bound by a plug such as Sentry | Failures that end at a boundary, to one reporter |
| [`@openknot-ts/versioning`](versioning/README.md)   | Versioning contract and native implementations   | Optimistic concurrency with `VersionConflict`     |
| [`@openknot-ts/lock`](lock/README.md)               | Lock contract and native implementations         | Exclusive, non-blocking execution with a lease    |
| [`@openknot-ts/cache`](cache/README.md)             | Cache layers over consumer-owned native stores   | Read-through, write-through and snapshot caching  |
| [`@openknot-ts/replication`](replication/README.md) | Instance and shared read layers across instances | `replicaStore` and `replicationChannel` contracts |
| [`@openknot-ts/outbox`](outbox/README.md) | `outboxStore` contract | Publications stored with their change, delivered after commit |

Framework packages decide where a capability applies, such as Flow's traced executions, and never depend on its implementations. Implementations for a transport or library are plugs, such as the [Knot health](../openknot-plugs/knot/knot-health/README.md) HTTP middleware and [OpenTelemetry tracing](../openknot-plugs/opentelemetry/opentelemetry-tracing/README.md), and [pino logging](../openknot-plugs/pino/pino-logging/README.md). Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
