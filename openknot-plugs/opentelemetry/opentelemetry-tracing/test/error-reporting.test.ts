import { telemetry } from "./support.ts";
import { error, failure } from "@openknot-ts/behavior";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import { listener, query } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { trace as tracingContract } from "@openknot-ts/tracing/wire";
import { defineApplication, override, runApplication } from "@openknot-ts/wire";
import type { SpanContext } from "@opentelemetry/api";
import { SpanKind, trace } from "@opentelemetry/api";
import assert from "node:assert/strict";
import { test } from "node:test";

const PaymentDeclined = error("PaymentDeclined");

test("a failed execution is reported while its span is active, so a reporter can link it to the trace", async () => {
  const otel = telemetry();
  const declined = listener({ handler: query({ run: () => failure(PaymentDeclined()) }) });
  // What an error tracker such as Sentry reads when it captures: the active span of the caller's context.
  const reported: { readonly report: ErrorReport; readonly span: SpanContext | undefined }[] = [];
  const app = await runApplication(defineApplication({ modules: [provideFlow([declined])] }), {
    overrides: [
      override(tracingContract, otel.tracing),
      override(errorReporter, (report: ErrorReport) => {
        reported.push({ report, span: trace.getSpan(otel.context.active())?.spanContext() });
      }),
    ],
  });
  try {
    await assert.rejects(app.resolve(declined)({ input: undefined }), PaymentDeclined.is);
    const span = otel.exporter.getFinishedSpans().find((each) => each.kind === SpanKind.CONSUMER);
    assert.equal(span?.name, "openknot.listener");
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.report.source, "openknot.listener");
    assert.deepEqual(reported[0]?.span, span?.spanContext());
  } finally {
    await app.stop();
    await otel.release();
  }
});
