import { openTelemetryTracing } from "../src/index.ts";
import { remote, remoteSpanId, remoteTraceId, telemetry } from "./support.ts";
import { failure, success } from "@openknot-ts/behavior";
import {
  command,
  expose,
  guard,
  hook,
  listener,
  publisher,
  query,
  scheduler,
  topic,
  unitOfWork,
} from "@openknot-ts/flow";
import type { PublishOptions, UowCommitted } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import type { PropagationCarrier, Tracing } from "@openknot-ts/tracing";
import { trace as tracingContract } from "@openknot-ts/tracing/wire";
import { composeModule, defineApplication, override, resource, runApplication, plug } from "@openknot-ts/wire";
import { trace, ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import assert from "node:assert/strict";
import { test } from "node:test";

test("nested work and staged publications retain their original parents; listener scopes link independently", async () => {
  const names = new Map<object, string>();
  const otel = telemetry({ spanName: (span) => (span.reference && names.get(span.reference)) ?? span.name });
  const delivered: PublishOptions[] = [];
  const sending = publisher<number>();
  const nested = command({
    requirements: { sending },
    run: async (_, ctx) => {
      await ctx.sending.publish(1);
      return success();
    },
  });
  const committed = hook<UowCommitted>()({ run: () => success() });
  const storage = unitOfWork({ hooks: { afterCommit: [committed] } });
  // Nested work explicitly joins the same configured transaction identity.
  const outer = command({
    requirements: { nested, sending },
    run: async (_, ctx) => {
      const result = await ctx.nested();
      if (result.isError) {
        return result;
      }
      await ctx.sending.publish(2);
      return success(ctx.actor);
    },
  });
  const access = guard({
    run: (_, ctx) => {
      assert.equal(ctx.actor, "alice");
      return success();
    },
  });
  const endpoint = expose({ handler: outer, guards: { access } });
  for (const [reference, name] of [
    [nested, "nested"],
    [outer, "outer"],
    [endpoint, "entry"],
    [sending, "publish"],
    [access, "access"],
  ] as const) {
    names.set(reference, name);
  }
  const binding = plug({
    port: sending,
    bind: () => (_event, options) => {
      delivered.push(options);
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([endpoint]), composeModule({ providers: { binding } })] }),
    {
      overrides: [override(tracingContract, otel.tracing)],
    },
  );
  try {
    const result = await app.resolve(endpoint)({
      input: undefined,
      access: undefined,
      actor: "alice",
      propagation: remote,
    });
    assert.equal(result, "alice");
    const spans = otel.exporter.getFinishedSpans();
    const entry = spans.find((s) => s.name === "entry")!;
    assert.equal(entry.spanContext().traceId, remoteTraceId);
    assert.equal(entry.parentSpanContext?.spanId, remoteSpanId);
    const publications = spans.filter((s) => s.name === "publish");
    assert.equal(publications.length, 2);
    assert.equal(
      publications[0]?.parentSpanContext?.spanId,
      spans.find((s) => s.name === "nested")?.spanContext().spanId,
    );
    assert.equal(
      publications[1]?.parentSpanContext?.spanId,
      spans.find((s) => s.attributes["openknot.execution.kind"] === "unit-of-work")?.spanContext().spanId,
    );
    assert.ok(spans.every((s) => s.attributes["user.id"] === undefined));
    assert.equal(delivered[0]?.propagation?.tracestate, remote.tracestate);
    assert.equal(Object.hasOwn(delivered[0]!, "actor"), false);

    const read = query({ run: (_, ctx) => success(ctx.actor) });
    const received = listener({ handler: read });
    const consumer = await runApplication(defineApplication({ modules: [provideFlow([received])] }), {
      overrides: [override(tracingContract, otel.tracing)],
    });
    try {
      const message = delivered[0]!;
      const result = await consumer.resolve(received)({
        input: undefined,
        propagation: message.propagation,
      });
      assert.equal(result, undefined);
      const span = otel.exporter.getFinishedSpans().find((s) => s.kind === SpanKind.CONSUMER)!;
      assert.equal(span.parentSpanContext, undefined);
      assert.notEqual(span.spanContext().traceId, remoteTraceId);
      assert.equal(span.links[0]?.context.spanId, publications[0]?.spanContext().spanId);
      assert.equal(span.links[0]?.context.traceId, remoteTraceId);
    } finally {
      await consumer.stop();
    }
  } finally {
    await app.stop();
    await otel.release();
  }
  // Keep native hook coverage independent from the publisher-only scenario above.
  const hooks = telemetry();
  const work = command({ unitOfWork: storage, run: () => success() });
  const api = expose({ handler: work });
  const transaction = plug({ port: storage, bind: () => ({ transaction: async (work) => work() }) });
  const hooked = await runApplication(
    defineApplication({ modules: [provideFlow([api]), composeModule({ providers: { transaction } })] }),
    { overrides: [override(tracingContract, hooks.tracing)] },
  );
  try {
    await hooked.resolve(api)({ input: undefined });
    assert.ok(hooks.exporter.getFinishedSpans().some((s) => s.name === "openknot.hook"));
  } finally {
    await hooked.stop();
    await hooks.release();
  }
});

test("scheduler ticks start independent traces even when the timer invokes them under an ambient span", async () => {
  const otel = telemetry();
  const tick = scheduler({
    schedule: { every: { seconds: 1 } },
    overlap: "allow",
    run: (_, ctx) => success(ctx.actor),
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([tick])] }), {
    overrides: [override(tracingContract, otel.tracing)],
  });
  try {
    await otel.tracing.run({ name: "timer" }, async () => {
      await Promise.all([
        app.resolve(tick)({ trigger: { scheduledAt: Date.now() } }),
        app.resolve(tick)({ trigger: { scheduledAt: Date.now() }, actor: "worker" }),
      ]);
    });
    const spans = otel.exporter.getFinishedSpans().filter((s) => s.name === "openknot.scheduler");
    assert.equal(spans.length, 2);
    assert.ok(spans.every((s) => s.parentSpanContext === undefined));
    assert.ok(spans.every((s) => typeof s.attributes["openknot.scheduler.scheduled_at"] === "string"));
    assert.notEqual(spans[0]?.spanContext().traceId, spans[1]?.spanContext().traceId);
    assert.equal(trace.getSpan(otel.context.active()), undefined);
  } finally {
    await app.stop();
    await otel.release();
  }
});

test("concurrent roots isolate context across await, and native HTTP instrumentation remains the parent", async () => {
  const otel = telemetry();
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  let count = 0;
  const api = expose({
    run: async () => {
      const before = trace.getSpan(otel.context.active())!.spanContext();
      if (++count === 2) {
        entered.resolve();
      }
      await finish.promise;
      assert.deepEqual(trace.getSpan(otel.context.active())!.spanContext(), before);
      return success(before);
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([api])] }), {
    overrides: [override(tracingContract, otel.tracing)],
  });
  try {
    const first = app.resolve(api)({ input: undefined, propagation: remote });
    const second = app.resolve(api)({
      input: undefined,
      propagation: { traceparent: `00-${"a".repeat(32)}-${remoteSpanId}-01` },
    });
    await entered.promise;
    finish.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.traceId, remoteTraceId);
    assert.equal(b.traceId, "a".repeat(32));
    const parent = otel.tracer.startSpan(
      "native HTTP",
      {},
      otel.propagator.extract(ROOT_CONTEXT, remote, { get: (c, k) => c[k as keyof typeof remote], keys: Object.keys }),
    );
    await otel.context.with(trace.setSpan(ROOT_CONTEXT, parent), () =>
      app.resolve(api)({ input: undefined, propagation: remote }),
    );
    parent.end();
    const spans = otel.exporter.getFinishedSpans();
    assert.ok(
      spans.some((s) => s.name === "openknot.expose" && s.parentSpanContext?.spanId === parent.spanContext().spanId),
    );
  } finally {
    finish.resolve();
    await app.stop();
    await otel.release();
  }
});

test("official propagation handles malformed headers, unsampled traces, casing and trace state", async () => {
  const otel = telemetry();
  try {
    let carrier: PropagationCarrier | undefined;
    await otel.tracing.run(
      {
        name: "openknot.expose",
        propagation: {
          TraceParent: `00-${remoteTraceId}-${remoteSpanId}-00`,
          TraceState: "vendor=value",
        },
      },
      async () => {
        const active = trace.getSpanContext(otel.context.active());
        assert.ok(active);
        assert.equal(active.traceFlags & TraceFlags.SAMPLED, TraceFlags.NONE);
        carrier = otel.tracing.capture();
      },
    );
    assert.equal(carrier?.traceparent?.split("-")[1], remoteTraceId);
    assert.ok(carrier?.traceparent?.endsWith("-00"));
    assert.equal(carrier?.tracestate, "vendor=value");
    assert.equal(otel.exporter.getFinishedSpans().length, 0);
    for (const traceparent of [
      "malformed",
      `00-${"0".repeat(32)}-${remoteSpanId}-01`,
      `00-${remoteTraceId}-${"0".repeat(16)}-01`,
    ]) {
      await otel.tracing.run({ name: "openknot.expose", propagation: { traceparent } }, async () => {
        const active = trace.getSpanContext(otel.context.active());
        assert.ok(active);
        assert.equal(active.traceFlags & TraceFlags.SAMPLED, TraceFlags.SAMPLED);
      });
    }
    assert.equal(otel.exporter.getFinishedSpans().length, 3);
    assert.ok(otel.exporter.getFinishedSpans().every((s) => s.parentSpanContext === undefined));
  } finally {
    await otel.release();
  }
});

test("domain failures and throws end error spans; telemetry failures never repeat application work", async () => {
  const otel = telemetry({
    attributes: () => ({ "app.test": "value" }),
  });
  const expected = new Error("expected");
  try {
    assert.deepEqual(
      await otel.tracing.run({ name: "openknot.command", failure: () => expected }, async () => failure(expected)),
      failure(expected),
    );
    await assert.rejects(
      otel.tracing.run({ name: "openknot.command" }, async () => {
        throw expected;
      }),
      (e) => e === expected,
    );
    const spans = otel.exporter.getFinishedSpans();
    assert.ok(spans.every((s) => s.ended && s.status.code === SpanStatusCode.ERROR));
    assert.equal(spans[0]?.attributes["app.test"], "value");
    let calls = 0;
    const broken = openTelemetryTracing({
      tracer: {
        ...otel.tracer,
        startSpan: () => {
          throw new Error("instrumentation");
        },
      },
      context: otel.context,
      propagator: otel.propagator,
      onError: () => {
        throw new Error("diagnostics");
      },
    });
    assert.equal(await broken.run({ name: "openknot.command" }, async () => ++calls), 1);
    assert.equal(calls, 1);
    const faulty: Tracing = {
      ...otel.tracing,
      async run(_span, work) {
        await work();
        throw new Error("after work");
      },
    };
    const api = expose({ run: () => success(++calls) });
    const app = await runApplication(defineApplication({ modules: [provideFlow([api])] }), {
      overrides: [override(tracingContract, faulty)],
    });
    try {
      assert.deepEqual(await app.resolve(api)({ input: undefined }), 2);
      assert.equal(calls, 2);
    } finally {
      await app.stop();
    }
  } finally {
    await otel.release();
  }
});

test("topic admission traces end before native stream lifetime and expose actor metadata to guards", async () => {
  const otel = telemetry();
  const admitted = guard({
    run: (_, ctx) => (ctx.actor === "alice" ? success() : failure(new Error("denied"))),
  });
  const updates = topic<string, number>()({ guards: { admitted } });
  const stream = (async function* () {
    yield 1;
  })();
  const binding = plug({ port: updates, bind: () => ({ subscribe: () => stream, publish() {} }) });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([updates]), composeModule({ providers: { binding } })] }),
    { overrides: [override(tracingContract, otel.tracing)] },
  );
  try {
    assert.equal(
      await app
        .resolve(updates)
        .subscribe({ input: "roles", admitted: undefined, actor: "alice", propagation: remote }),
      stream,
    );
    assert.ok(otel.exporter.getFinishedSpans().some((s) => s.name === "openknot.subscribe" && s.ended));
    await stream.return(undefined);
  } finally {
    await app.stop();
    await otel.release();
  }
});

test("explicit baggage propagators retain baggage across linked message processing without exporting actor identity", async () => {
  const otel = telemetry();
  const tracing = openTelemetryTracing({
    tracer: otel.tracer,
    context: otel.context,
    propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  });
  try {
    assert.ok(tracing.propagationFields?.includes("baggage"));
    await tracing.run(
      {
        name: "process",
        kind: "consumer",
        root: true,
        propagation: { ...remote, baggage: "tenant=blue" },
      },
      async () => {
        const carrier = tracing.capture();
        assert.equal(carrier?.baggage, "tenant=blue");
        assert.notEqual(carrier?.traceparent?.split("-")[1], remoteTraceId);
        assert.ok(!JSON.stringify(carrier).includes("alice"));
      },
    );
    assert.equal(otel.exporter.getFinishedSpans()[0]?.links[0]?.context.traceId, remoteTraceId);
  } finally {
    await otel.release();
  }
});

test("rollback discards delivery spans and after-commit callbacks retain their captured native context", async () => {
  const otel = telemetry();
  const output = publisher<number>();
  const expected = new Error("rollback");
  let effectParent: string | undefined;
  let originalParent: string | undefined;
  let deliveries = 0;
  const change = command<boolean>()({
    requirements: { output },
    run: async (rollback, ctx) => {
      originalParent = trace.getSpan(otel.context.active())!.spanContext().spanId;
      ctx.uow.afterCommit(() => {
        effectParent = trace.getSpan(otel.context.active())!.spanContext().spanId;
      });
      await ctx.output.publish(1);
      return rollback ? failure(expected) : success();
    },
  });
  const endpoint = expose({ handler: change });
  const binding = plug({
    port: output,
    bind: () => () => {
      deliveries++;
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([endpoint]), composeModule({ providers: { binding } })] }),
    { overrides: [override(tracingContract, otel.tracing)] },
  );
  try {
    await assert.rejects(app.resolve(endpoint)({ input: true }), (error) => error === expected);
    assert.equal(deliveries, 0);
    assert.equal(effectParent, undefined);
    assert.ok(!otel.exporter.getFinishedSpans().some((s) => s.name === "openknot.publish"));
    await app.resolve(endpoint)({ input: false });
    assert.equal(effectParent, originalParent);
    assert.equal(deliveries, 1);
    assert.equal(otel.exporter.getFinishedSpans().filter((s) => s.name === "openknot.publish").length, 1);
  } finally {
    await app.stop();
    await otel.release();
  }
});

test("input spans include native Wire scope initialization and release failures", async () => {
  const otel = telemetry();
  const failed = new Error("native scope failure");
  try {
    for (const phase of ["initialize", "release"] as const) {
      let activeDuringCleanup: string | undefined;
      const native = resource({
        lifetime: "scoped",
        initialize: async () => {
          if (phase === "initialize") {
            throw failed;
          }
          return {
            value: 1,
            release() {
              activeDuringCleanup = trace.getSpan(otel.context.active())?.spanContext().spanId;
              throw failed;
            },
          };
        },
      });
      // The endpoint needs the native session, so its scope acquires and releases it.
      const endpoint = expose({ requirements: { native }, run: () => success() });
      const app = await runApplication(defineApplication({ modules: [provideFlow([endpoint])] }), {
        overrides: [override(tracingContract, otel.tracing)],
      });
      try {
        await assert.rejects(app.resolve(endpoint)({ input: undefined }));
        const span = otel.exporter.getFinishedSpans().at(-1)!;
        assert.equal(span.name, "openknot.expose");
        assert.equal(span.status.code, SpanStatusCode.ERROR);
        assert.equal(span.ended, true);
        if (phase === "release") {
          assert.equal(activeDuringCleanup, span.spanContext().spanId);
        }
      } finally {
        await app.stop();
      }
    }
  } finally {
    await otel.release();
  }
});

test("correlation names the active span, and nothing outside a recorded one", async () => {
  const otel = telemetry();
  try {
    assert.equal(otel.tracing.correlation?.(), undefined);
    let inside: unknown;
    await otel.tracing.run({ name: "work" }, async () => {
      inside = otel.tracing.correlation?.();
    });
    const span = otel.exporter.getFinishedSpans().at(-1)!;
    assert.deepEqual(inside, { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId });
  } finally {
    await otel.release();
  }
});
