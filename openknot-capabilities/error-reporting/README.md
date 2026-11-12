# OpenKnot error reporting

`@openknot-ts/error-reporting` is OpenKnot's error reporting contract. Flow and plugs hand every failure that ends at a boundary to the application's reporter, such as Sentry. Without a bound reporter nothing is reported. Logging is not the reporter's job: failures are logged through the application's [logger](../logging/README.md) as before. The package has no dependencies.

```text
Flow, plugs (where)          → ErrorReport { error, source, expected, reference?, attributes? }
@openknot-ts/error-reporting → errorReporter contract, isReported, reportError
implementation (plug)        → the native SDK, such as Sentry
```

## What is reported

- **Flow executions**, once, where their input ends: an exposure, listener, scheduler or subscription admission. A failure a nested command returns reaches the input that called it and is reported there. The source is `openknot.<kind>`, such as `openknot.listener`, the reference is the input port, and the attributes are the execution's trace attributes, such as `messaging.message.id`. With tracing selected, the report runs while the execution's span is active, so a reporter that reads the active trace links the failure to it. Flow's per-kind [execution logs](../../openknot-flow/README.md#actors-tracing-and-logging) log the same executions.
- **Failures no caller receives**, from plugs and capabilities: RabbitMQ connection errors, topology recovery and undecodable deliveries (`openknot.rabbitmq`), an HTTP dispatch failure (`openknot.http`), an unavailable cache layer (`openknot.cache`), a failed replication (`openknot.replication`) and an outbox delivery round (`openknot.outbox`). Their `attributes` name the instance, such as `openknot.cache.name`. RabbitMQ, the outbox and the Node HTTP host also log them through the logger; the Bun HTTP host leaves them to Bun's own error handling.

`expected` is `false` for `InternalFlowError`, `InternalBehaviorError`, `UnitOfWorkError`, `PostCommitError` and every failure no caller receives. Authored failures, such as a business error an operation returns, and anticipated framework failures, such as `VersionConflict`, are expected. The caller's own cancellation is never reported.

## Implement and bind

The optional `/wire` entry exports `errorReporter`, a `unit.contract<ErrorReporter>()` without an implementation of its own. Flow and plugs consume `optional(errorReporter)`; an implementation provides it:

```ts
import type { ErrorReporter } from "@openknot-ts/error-reporting";
import { isReported } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import { unit } from "@openknot-ts/wire";

const tracker = unit({
  provides: errorReporter,
  factory: (): ErrorReporter => (report) => {
    if (isReported(report, [PaymentDeclined])) {
      send(report);
    }
  },
});
```

A reporter is a function of an `ErrorReport`. `isReported(report, errors)` applies the usual selection: every unexpected failure, and the expected ones `errors` names, as an `error()` factory or any `{ is(error) }`. `reportError(reporter, report)` delivers a report when a reporter is bound, without letting a failing reporter fail the work that reported.

[`@openknot-ts/sentry-node`](../../openknot-plugs/sentry/sentry-node/README.md) and [`@openknot-ts/sentry-bun`](../../openknot-plugs/sentry/sentry-bun/README.md) report to Sentry.
