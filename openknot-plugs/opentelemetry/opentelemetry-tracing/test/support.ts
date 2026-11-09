import type { OpenTelemetryTracingOptions } from "../src/index.ts";
import { openTelemetryTracing } from "../src/index.ts";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

export function telemetry(
  options: Partial<Omit<OpenTelemetryTracingOptions, "tracer" | "context" | "propagator">> = {},
) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const context = new AsyncLocalStorageContextManager().enable();
  const tracer = provider.getTracer("@openknot-ts/flow", "0.1.0");
  const propagator = new W3CTraceContextPropagator();
  const tracing = openTelemetryTracing({ ...options, tracer, context, propagator });
  return {
    provider,
    exporter,
    context,
    tracer,
    propagator,
    tracing,
    async release() {
      await provider.shutdown();
      context.disable();
    },
  };
}

export const remoteTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
export const remoteSpanId = "00f067aa0ba902b7";
export const remote = { traceparent: `00-${remoteTraceId}-${remoteSpanId}-01`, tracestate: "example=upstream" };
