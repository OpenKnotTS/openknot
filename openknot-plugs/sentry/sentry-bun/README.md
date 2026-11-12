# OpenKnot Sentry for Bun

`@openknot-ts/sentry-bun` reports the application's failures to Sentry through `@sentry/bun`. It implements the [error reporting contract](../../../openknot-capabilities/error-reporting/README.md): each reported failure becomes a Sentry issue tagged with `openknot.source`, with the report's attributes, such as the message id, as its `openknot` context. The Node runtime uses [`@openknot-ts/sentry-node`](../sentry-node/README.md).

## Usage

The module owns the SDK, with options from validated config:

```ts
import { provideSentry } from "@openknot-ts/sentry-bun";
import { config } from "@openknot-ts/wire";
import { z } from "zod";

const settings = config({ SENTRY_DSN: z.url(), SENTRY_ENVIRONMENT: z.string() });

const errors = provideSentry({
  requirements: { settings },
  options: ({ settings }) => ({ dsn: settings.SENTRY_DSN, environment: settings.SENTRY_ENVIRONMENT }),
  errors: [PaymentDeclined],
});

// defineApplication({ modules: [applicationModule, errors] })
```

The module calls `Sentry.init()` at startup and closes its client at shutdown, after the application's work has drained, so pending events are sent. It waits as long as the native `shutdownTimeout` option, two seconds by default.

The SDK keeps one client per process, so one application owns it: startup fails when Sentry is already initialized, by another `Sentry.init()` or another application's module. Shutdown closes only the module's own client and releases the process's Sentry for a later application. The application does not call `Sentry.init()` itself, so Sentry's own instrumentation, which needs initializing before anything else is imported, is not part of this module.

## API

| Export | Description |
| --- | --- |
| `provideSentry({ requirements?, options, errors? })` | Owns the SDK and provides the error reporter as a module. |
| `SentryModule`, `SentryModuleOptions` | Types. |

- `options(dependencies)` returns the SDK's own options, every native option included.
- `errors` is a list, or a function of the requirements, of the expected failures to report as well: an `error()` factory or any `{ is(error) }`. Unexpected failures are always reported.
- Startup fails when its requirements are not registered, so a missing setting never silently disables reporting.
- Unexpected failures reach Sentry as unhandled (`mechanism.handled: false`), expected ones as handled.

## Link issues to traces

Flow reports a failed execution while its span is still active, and cache and replication report inside the spans of their failures. With [OpenTelemetry tracing](../../opentelemetry/opentelemetry-tracing/README.md) selected, Sentry links each issue to that span once its OpenTelemetry integration reads the application's pipeline:

```ts
options: ({ settings }) => ({
  dsn: settings.SENTRY_DSN,
  enableOpenTelemetrySetup: false,
  integrations: [Sentry.openTelemetryIntegration()],
}),
```

Register the OpenTelemetry provider before Sentry starts. The two modules stay independent: they meet only through the active OpenTelemetry context.
