# tRPC plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output.

| Package                                                                    | Responsibility                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`@openknot-ts/trpc-router`](trpc-router/README.md)                           | Router declarations, composition and the default instance   |
| [`@openknot-ts/trpc-context`](trpc-context/README.md)                         | Request context from actor resolution and trace propagation |
| [`@openknot-ts/trpc-knot-server-handler`](trpc-knot-server-handler/README.md) | tRPC handler for the Knot HTTP host                         |
| [`@openknot-ts/trpc-fastify`](trpc-fastify/README.md)                         | tRPC on the Fastify host through the official plugin        |
| [`@openknot-ts/auth0-authentication`](middleware/auth0-authentication/README.md) | Auth0-backed native middleware for protected tRPC procedures |

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. `middleware/` is another grouping folder with no manifest or build output. Applications install the router, the context and only the host adapter and middleware they select; neither the router nor the context loads an HTTP host, Auth0 plug or server SDK adapter. The workspace, catalog and lockfile live at the repository root.
