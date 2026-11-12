# OpenKnot Sentry module

`@openknot-ts/sentry` holds what [`@openknot-ts/sentry-node`](../sentry-node/README.md) and [`@openknot-ts/sentry-bun`](../sentry-bun/README.md) share: `sentryModule(sdk)` builds a runtime's `provideSentry` over that runtime's SDK. Applications install a runtime plug instead of this package.
