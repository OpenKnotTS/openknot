import { telemetry } from "./support.ts";
import { success } from "@openknot-ts/behavior";
import { listener, query } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { provideOpenTelemetry } from "@openknot-ts/opentelemetry-tracing/wire";
import type { PropagationCarrier } from "@openknot-ts/tracing";
import { defineApplication, runApplication } from "@openknot-ts/wire";

// Separate process and independent SDK: only a text-map carrier crosses the boundary.
const propagation = JSON.parse(process.argv[2]!) as PropagationCarrier;
const otel = telemetry({ consumerParent: "parent" });
const read = query({ run: () => success() });
const incoming = listener({ handler: read });
const app = await runApplication(
  defineApplication({
    modules: [
      provideFlow([incoming]),
      provideOpenTelemetry({
        factory: () => ({
          tracer: otel.tracer,
          context: otel.context,
          propagator: otel.propagator,
          consumerParent: "parent",
        }),
      }),
    ],
  }),
);
try {
  await app.resolve(incoming)({ input: undefined, propagation });
  process.stdout.write(
    JSON.stringify(
      otel.exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        context: span.spanContext(),
        parent: span.parentSpanContext,
        links: span.links,
      })),
    ),
  );
} finally {
  await app.stop();
  await otel.release();
}
