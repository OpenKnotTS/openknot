# Knot plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output. OpenKnot's own defaults: the plugs a quick start selects without third-party infrastructure.

| Package                                                | Responsibility                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| [`@openknot-ts/knot-http-node`](knot-http-node/README.md) | Native Node HTTP host, `httpHandler` and `httpMiddleware` contracts |
| [`@openknot-ts/knot-http-bun`](knot-http-bun/README.md)   | Native Bun HTTP host, Fetch handler and middleware contracts        |
| [`@openknot-ts/knot-health`](knot-health/README.md)       | Health probes for the Node and Fastify hosts, and shared routing    |
| [`@openknot-ts/knot-health-bun`](knot-health-bun/README.md) | Health probes as Bun HTTP middleware                            |
| [`@openknot-ts/knot-pubsub`](knot-pubsub/README.md)       | Local topic/broadcast delivery over a provided EventEmitter         |
| [`@openknot-ts/knot-lock`](knot-lock/README.md)           | In-process lock for single instances and tests                      |
| [`@openknot-ts/knot-rest`](knot-rest/README.md)           | REST routes over exposures, independent of the HTTP host            |
| [`@openknot-ts/knot-rest-http-node`](knot-rest-http-node/README.md) | REST routes on the native Node host                       |
| [`@openknot-ts/knot-rest-http-bun`](knot-rest-http-bun/README.md)   | REST routes on the native Bun host                        |
| [`@openknot-ts/knot-rest-fastify`](knot-rest-fastify/README.md)     | REST routes on the Fastify host                           |

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
