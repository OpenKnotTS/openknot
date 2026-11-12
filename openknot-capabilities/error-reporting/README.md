# OpenKnot error reporting

`@openknot-ts/error-reporting` is OpenKnot's error reporting contract. Flow and plugs hand every failure that ends at a boundary to the application's reporter, such as Sentry. Installing it reports nothing: Flow and plugs need only its contract, as they need tracing's, and without a bound reporter `errorReports` does nothing. Logging is not the reporter's job: failures are logged through the application's [logger](../logging/README.md) whether a reporter is bound or not. The package has no dependencies; its `/wire` entry uses `@openknot-ts/wire` and `@openknot-ts/logging`.

```text
Flow, plugs (where)          → ErrorReport { error, source, expected, reference?, attributes? }
@openknot-ts/error-reporting → errorReporter contract, errorReports, unattendedFailures, isReported
implementation (plug)        → the native SDK, such as Sentry
```

## What is reported

- **Flow executions**, once, where their input ends: an exposure, listener, scheduler or subscription admission. A failure a nested command returns reaches the input that called it and is reported there. The source is `openknot.<kind>`, such as `openknot.listener`, the reference is the input port, and the attributes are the execution's trace attributes, such as `messaging.message.id`. With tracing selected, the report runs while the execution's span is active, so a reporter that reads the active trace links the failure to it. Flow's per-kind [execution logs](../../openknot-flow/README.md#actors-tracing-and-logging) log the same executions.
- **Failures no caller receives**, from plugs and capabilities: RabbitMQ connection errors, topology recovery and undecodable deliveries (`openknot.rabbitmq`), a lost Redis connection (`openknot.redis`), an HTTP dispatch failure (`openknot.http`), an unavailable cache layer (`openknot.cache`), a failed replication (`openknot.replication`) and an outbox delivery round (`openknot.outbox`). Their `attributes` name the instance, such as `openknot.cache.name`. Each goes through `unattendedFailures`, so it is also logged at `error` as `<source> failed`, with the same attributes.

`expected` is `false` for `InternalFlowError`, `InternalBehaviorError`, `UnitOfWorkError`, `PostCommitError` and every failure no caller receives. Authored failures, such as a business error an operation returns, and anticipated framework failures, such as `VersionConflict`, are expected. The caller's own cancellation is never reported.

## Implement and bind

The optional `/wire` entry exports `errorReporter`, a `unit.contract<ErrorReporter>()` without an implementation of its own. Flow and plugs hand their reports to `errorReports`, which delivers them to the bound reporter; an implementation provides it:

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

A reporter is a function of an `ErrorReport`. `isReported(report, errors)` applies the usual selection: every unexpected failure, and the expected ones `errors` names, as an `error()` factory or any `{ is(error) }`. `errorReports` delivers a report when a reporter is bound, without letting a failing reporter fail the work that reported: the reporter's own failure is logged through the application's logger as `openknot.error-reporting failed`, with the error it was reporting.

## Failures no caller receives

A plug or capability hands such a failure, a lost connection or a failed background round, to `unattendedFailures` from the `/wire` entry instead of logging and reporting it itself:

```ts
import { unattendedFailures } from "@openknot-ts/error-reporting/wire";

export const consumer = plug({
  port: orderPlaced,
  requirements: { failures: unattendedFailures },
  bind: ({ invoke, failures }) => {
    client.on("crash", (error) => failures({ error, source: "kafka", attributes: { "messaging.destination.name": topic } }));
    // ...
  },
});
```

It always logs the failure through the application's logger at `error` as `<source> failed` with its attributes, and reports it as unexpected when a reporter is bound, so no such failure is silent. An application rebinds it once to handle every such failure elsewhere. A failure inside a Flow execution needs none of this: Flow logs and reports it where its input ends.

[`@openknot-ts/sentry-node`](../../openknot-plugs/sentry/sentry-node/README.md) and [`@openknot-ts/sentry-bun`](../../openknot-plugs/sentry/sentry-bun/README.md) report to Sentry.
