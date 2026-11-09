# OpenKnot tracing

`@openknot-ts/tracing` is OpenKnot's own tracing contract. Instrumentation, such as Flow, describes each traced unit of work as a neutral span; an implementation records it and propagates its context. The package has no dependencies, imports no tracing library and creates no IDs.

```text
Flow, plugs (where)        → TraceSpan { name, kind?, root?, propagation?, attributes?, reference?, failure? }
@openknot-ts/tracing (API)    → Tracing { run, capture, bind, propagationFields }
implementation (plug)      → native spans, IDs, sampling, propagation format and export
```

- **`kind`** is the span's remote role: `"server"`, `"client"`, `"producer"` or `"consumer"`. A span without a kind is local to its process.
- **`root`** starts an independent trace. A supplied carrier then becomes a link instead of a parent, as for listener deliveries and scheduler ticks.
- **`propagation`** is a remote context produced by `capture()` on the other side. Carriers are opaque string records; the implementation selects their fields (`propagationFields`) and format.
- **`failure(result)`** lets instrumentation report a failure the work returned instead of throwing, such as a failed Outcome.

## Instrument

`withTrace(tracing, span, work)` runs `work` inside a span, or directly when no implementation is bound. Instrumentation never fails business work: the work runs exactly once and keeps its own result or rejection, even when the implementation throws, skips or repeats it. `capturePropagation(tracing)` and `bindTrace(tracing, work)` apply the same rule to carrier capture and to deferred work: a bound work runs once, also when its binding fails as it is called. `propagationFields(tracing)` names the carrier fields a transport selects: the implementation's own, or W3C Trace Context (`traceparent`, `tracestate`).

```ts
import { capturePropagation, withTrace } from "@openknot-ts/tracing";

await withTrace(tracing, { name: "send roles", kind: "producer", attributes }, async () => {
  const carrier = capturePropagation(tracing);
  await send(message, carrier);
});
```

Flow instruments inputs, handlers, guards, hooks, UoWs, publications and subscription admission itself and passes the bound implementation to native bindings as `invoke.tracing` and `PublishOptions.tracing`. Applications only select an implementation.

## Implement and bind

The optional `/wire` entry exports `trace`, a `unit.contract<Tracing>()` without an implementation of its own. Instrumentation consumes `optional(trace)` and receives `undefined` until an implementation provides it:

```ts
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";

const timing = unit({
  provides: trace,
  factory: (): Tracing => ({
    async run(span, work) {
      const started = performance.now();
      try {
        return await work();
      } finally {
        console.log(`${span.name}: ${(performance.now() - started).toFixed(2)} ms`);
      }
    },
    capture: () => undefined,
    bind: (work) => work,
  }),
});
```

[`@openknot-ts/opentelemetry-tracing`](../../openknot-plugs/opentelemetry/opentelemetry-tracing/README.md) implements the contract over the standard OpenTelemetry API. The [console timing example](../../openknot-flow/examples/trace.ts) binds the local implementation above (`pnpm --filter @openknot-ts/flow example:trace`).
