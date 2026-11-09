# Auth0 plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output. The Auth0 plug includes its `jose` runtime dependency and is ready to use with issuer, audience and actor mapping.

| Package                                          | Responsibility                              |
| ------------------------------------------------ | ------------------------------------------- |
| [`@openknot-ts/auth0-actor`](auth0-actor/README.md) | Native JWT/JWKS verification and actor mapping |

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
