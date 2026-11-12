import type {
  PropagationCarrier,
  TraceCorrelation,
  TraceSpan,
  SpanKind as TraceSpanKind,
  Tracing,
} from "@openknot-ts/tracing";
import type {
  Attributes,
  ContextManager,
  Link,
  Span,
  TextMapGetter,
  TextMapPropagator,
  TextMapSetter,
  Tracer,
} from "@opentelemetry/api";
import {
  context as globalContext,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export interface OpenTelemetryTracingOptions {
  readonly tracer: Tracer;
  readonly propagator: TextMapPropagator;
  /** Consumer-owned context manager, or the API's already configured global context. */
  readonly context?: Pick<ContextManager, "active" | "with" | "bind">;
  /** A consumer root links to its producer by default; parent is available for individual-message processing. */
  readonly consumerParent?: "link" | "parent";
  readonly spanName?: (span: TraceSpan) => string;
  /** Actor identity is recorded only when this application-owned callback selects it. */
  readonly attributes?: (span: TraceSpan) => Attributes;
  readonly onError?: (error: unknown) => void;
}

const getter: TextMapGetter<PropagationCarrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) =>
    carrier[key] ?? carrier[Object.keys(carrier).find((name) => name.toLowerCase() === key.toLowerCase()) ?? ""],
};

const setter: TextMapSetter<Record<string, string>> = {
  set: (carrier, key, value) => {
    carrier[key] = value;
  },
};

const kinds: Readonly<Record<TraceSpanKind, SpanKind>> = Object.freeze({
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
});

/** Messaging spans follow the OpenTelemetry `{operation} {destination}` naming convention. */
function spanName(described: TraceSpan): string {
  const destination = described.attributes?.["messaging.destination.name"];
  const action = described.attributes?.["messaging.operation.name"];
  return typeof action === "string" && typeof destination === "string" ? `${action} ${destination}` : described.name;
}

/** Instrumentation only: never creates, registers, configures or shuts down an SDK. */
export function openTelemetryTracing(options: OpenTelemetryTracingOptions): Tracing {
  const { tracer, propagator, context = globalContext, consumerParent = "link" } = options;

  function report(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      /* Diagnostics must not affect application work. */
    }
  }

  function safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      report(error);
    }
  }

  function failed(span: Span | undefined, error: unknown): void {
    if (span === undefined) {
      return;
    }
    safely(() => {
      const exception = error instanceof Error ? error : { message: String(error) };
      span.setAttribute("error.type", error instanceof Error ? error.name : typeof error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(exception);
    });
  }

  return Object.freeze({
    propagationFields: Object.freeze([...propagator.fields()]),
    async run<T>(described: TraceSpan, work: () => Promise<T>): Promise<T> {
      let span: Span | undefined;
      let pending: Promise<T> | undefined;
      const execute = () => (pending ??= Promise.resolve().then(work));
      let task: Promise<T>;

      try {
        const detached = described.root === true;
        const ambient = context.active();
        const incoming =
          described.propagation === undefined
            ? undefined
            : propagator.extract(detached ? ROOT_CONTEXT : ambient, described.propagation, getter);

        let parent = incoming ?? (detached ? ROOT_CONTEXT : ambient);

        // Continue an active span of the incoming trace, such as an HTTP/server span from native instrumentation.
        if (!detached) {
          const activeSpan = trace.getSpan(ambient);
          const active = activeSpan?.spanContext();
          const remote = incoming === undefined ? undefined : trace.getSpanContext(incoming);

          if (
            activeSpan !== undefined &&
            active !== undefined &&
            isSpanContextValid(active) &&
            (remote === undefined || !isSpanContextValid(remote) || remote.traceId === active.traceId)
          ) {
            parent = trace.setSpan(incoming ?? ambient, activeSpan);
          }
        }

        const links: Link[] = [];

        if (detached) {
          const remote = incoming === undefined ? undefined : trace.getSpanContext(incoming);

          if (remote !== undefined && isSpanContextValid(remote)) {
            links.push({ context: remote });
          }

          if (described.kind !== "consumer" || consumerParent === "link") {
            parent = trace.deleteSpan(incoming ?? ROOT_CONTEXT);
          }
        }

        span = tracer.startSpan(
          options.spanName?.(described) ?? spanName(described),
          {
            kind: described.kind === undefined ? SpanKind.INTERNAL : kinds[described.kind],
            links,
            attributes: { ...described.attributes, ...options.attributes?.(described) },
          },
          parent,
        );

        task = context.with(trace.setSpan(parent, span), execute);
      } catch (error) {
        report(error);
        task = execute();
      }
      try {
        const value = await task;

        safely(() => {
          const error = described.failure?.(value);
          if (error !== undefined) {
            failed(span, error);
          }
        });

        return value;
      } catch (error) {
        failed(span, error);
        throw error;
      } finally {
        if (span !== undefined) {
          safely(() => span!.end());
        }
      }
    },
    correlation(): TraceCorrelation | undefined {
      try {
        const active = trace.getSpanContext(context.active());
        return active === undefined || !isSpanContextValid(active)
          ? undefined
          : Object.freeze({ traceId: active.traceId, spanId: active.spanId });
      } catch (error) {
        report(error);
        return undefined;
      }
    },
    capture(): PropagationCarrier | undefined {
      try {
        const carrier: Record<string, string> = {};
        propagator.inject(context.active(), carrier, setter);

        return Object.keys(carrier).length === 0 ? undefined : Object.freeze(carrier);
      } catch (error) {
        report(error);
        return undefined;
      }
    },
    bind<T>(work: () => Promise<T>): () => Promise<T> {
      try {
        return context.bind(context.active(), work);
      } catch (error) {
        report(error);
        return work;
      }
    },
  });
}
