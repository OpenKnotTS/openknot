# @openknot-ts/opentelemetry-tracing

Implements OpenKnot's [tracing API](../../../openknot-capabilities/tracing/README.md) over the standard OpenTelemetry JavaScript API. It maps the neutral span fields (`kind`, `root`, `propagation`, `attributes`, `failure`) and depends on neither Flow nor an SDK: the application chooses the SDK, provider, sampler, exporter and their lifecycle.

The only peer is `@opentelemetry/api >=1.9.0 <2`. The root entry runs without Wire; `/wire` composes it as a module.

## Usage

Let the module own the SDK's lifecycle:

```ts
import { provideOpenTelemetry } from "@openknot-ts/opentelemetry-tracing/wire";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { ConsoleSpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const observability = provideOpenTelemetry({
  initialize: async (_dependencies, { signal }) => {
    signal.throwIfAborted();

    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() })],
    });
    const context = new AsyncLocalStorageContextManager().enable();

    return {
      value: { tracer: provider.getTracer("my-app"), propagator: new W3CTraceContextPropagator(), context },
      async release() {
        try {
          await provider.shutdown();
        } finally {
          context.disable();
        }
      },
    };
  },
});

// defineApplication({ modules: [applicationModule, observability] })
```

Or use SDK instances managed elsewhere:

```ts
const observability = provideOpenTelemetry({
  requirements: { telemetry },
  factory: ({ telemetry }) => ({ tracer: telemetry.tracer, propagator: telemetry.propagator, context: telemetry.context }),
});
```

`factory` and `initialize` are mutually exclusive. The module provides Flow's `trace` contract only when its requirements are registered; without it, Flow makes no telemetry calls. Use `resourceOrder` when the SDK must start before other resources.

## API

| Entry | Export | Description |
| --- | --- | --- |
| root | `openTelemetryTracing(options)`, `OpenTelemetryTracingOptions` | The `Tracing` implementation, without Wire. |
| `/wire` | `provideOpenTelemetry({ requirements?, factory \| initialize })` | Provides the implementation as a module. |

## Options

- `tracer`, `propagator`: required standard API implementations. W3C Trace Context is the usual propagator; B3 and others work too.
- `context`: optional `active`/`with`/`bind` implementation; defaults to the global API context.
- `consumerParent`: `"link"` (default) links each delivery's processing span to the message; `"parent"` continues the producer trace.
- `spanName(span)`: custom names; messaging spans default to `{operation} {destination}`.
- `attributes(span)`: application-selected attributes. Spans carry no actor or credentials.
- `onError(error)`: diagnostics for instrumentation failures.

## What is traced

- Exposures, listener deliveries, scheduler ticks, commands, queries, guards, Units of Work and their hooks, topic and broadcast admission, and publications.
- Local spans are `INTERNAL`, listener processing `CONSUMER`; `producer`, `server` and `client` keep their kinds. RabbitMQ sends become `PRODUCER` spans automatically.
- An active span from native instrumentation, such as an HTTP server span, stays the parent. Scheduler ticks start new traces.
- Staged publications and after-commit effects keep the context they were staged in; rollback creates no delivery span.
- Instrumentation failures never change the business result, and work runs once.
- `correlation()` returns the active span's `traceId` and `spanId` from the same context, so [`@openknot-ts/logging`](../../../openknot-capabilities/logging/README.md) records join their traces.

Propagation travels as an immutable carrier separate from input and actor; plugs carry only the propagator's `propagationFields`. Transports add `traceAttributes`: RabbitMQ adds the messaging system, destination, routing key, operation and message id. RabbitMQ spans follow the [messaging](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/) and [RabbitMQ](https://opentelemetry.io/docs/specs/semconv/messaging/rabbitmq/) semantic conventions.

## Example and tests

```sh
pnpm build
pnpm --filter @openknot-ts/opentelemetry-tracing example
```

[examples/tracing.ts](examples/tracing.ts) traces an exposure, a listener and a scheduler tick. The tests use real SDK providers with in-memory exporters: W3C propagation through AMQP adapters and a second Node process, links, parent mode, scheduler isolation, sampling, malformed headers and API-only imports.
