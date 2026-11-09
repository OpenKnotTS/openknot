# Fastify plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output. Plugs over a native Fastify instance.

| Package                                              | Responsibility                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@openknot-ts/fastify-server`](fastify-server/README.md) | The Fastify host: lifecycle, the selected native plugins and graceful drain |

Protocols join the host through its `fastifyPlugins` collection: [`@openknot-ts/trpc-fastify`](../trpc/trpc-fastify/README.md) serves tRPC, [`@openknot-ts/knot-rest-fastify`](../knot/knot-rest-fastify/README.md) serves REST routes and [`@openknot-ts/knot-health/fastify`](../knot/knot-health/README.md) serves the health probes.

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
