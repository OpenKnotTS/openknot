# Sentry plugs

This folder groups independent workspace packages. It has no package manifest, entry point or build output. Plugs over Sentry's runtime SDKs.

| Package | Responsibility |
| --- | --- |
| [`@openknot-ts/sentry-node`](sentry-node/README.md) | Reported failures as Sentry issues, through `@sentry/node` |
| [`@openknot-ts/sentry-bun`](sentry-bun/README.md) | Reported failures as Sentry issues, through `@sentry/bun` |
| [`@openknot-ts/sentry`](sentry/README.md) | The module both share |

Each package owns its dependencies and `src`, `test` and `dist` directories, and each module lists only its own definitions. The workspace, catalog and lockfile live at the repository root.
