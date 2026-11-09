import { telemetry } from "./support.ts";
import { success } from "@openknot-ts/behavior";
import { command, expose } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { provideOpenTelemetry } from "@openknot-ts/opentelemetry-tracing/wire";
import { trace } from "@openknot-ts/tracing/wire";
import { defineApplication, optional, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, W3CTraceContextPropagator } from "@opentelemetry/core";
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { test } from "node:test";

test("a tracing module binds itself only when its SDK reference is registered, without replace or factory probes", async () => {
  let opened = 0,
    configured = 0,
    released = 0,
    reads = 0;
  const instances: ReturnType<typeof telemetry>[] = [];
  const sdk = resource({
    initialize: async () => {
      opened++;
      const native = telemetry();
      instances.push(native);
      return {
        value: native,
        async release() {
          released++;
          await native.release();
        },
      };
    },
  });
  const diagnostics = unit({
    factory: () => {
      throw new Error("an optional service must stay absent");
    },
  });
  const observability = provideOpenTelemetry({
    requirements: {
      get sdk() {
        reads++;
        return sdk;
      },
      diagnostics: optional(diagnostics),
    },
    factory: ({ sdk, diagnostics }) => {
      configured++;
      assert.equal(diagnostics, undefined);
      return sdk;
    },
  });
  assert.equal(reads, 1);
  const api = expose({ run: () => success(42) });
  const flow = provideFlow([api]);
  const native = providePlugs([sdk]);
  for (const modules of [
    [flow, observability],
    [flow, observability, native.when(false)],
  ]) {
    const app = await runApplication(defineApplication({ modules }));
    try {
      assert.equal(app.resolve(optional(trace)), undefined);
      assert.deepEqual(await app.resolve(api)({ input: undefined }), 42);
      assert.equal(opened, 0);
      assert.equal(configured, 0);
    } finally {
      await app.stop();
    }
  }
  const app = await runApplication(defineApplication({ modules: [observability, flow, native] }));
  try {
    const tracing = app.resolve(trace);
    assert.ok(tracing);
    assert.equal(app.resolve(trace), tracing);
    assert.deepEqual(await app.resolve(api)({ input: undefined }), 42);
    assert.deepEqual(await app.resolve(api)({ input: undefined }), 42);
    assert.equal(opened, 1);
    assert.equal(configured, 1);
    assert.equal(instances[0]?.exporter.getFinishedSpans().filter((span) => span.name === "openknot.expose").length, 2);
  } finally {
    await app.stop();
  }
  assert.equal(released, 1);
});

test("a managed tracing module owns independent SDK resources for each application", async () => {
  const instances: ReturnType<typeof telemetry>[] = [];
  let released = 0;
  const observability = provideOpenTelemetry({
    initialize: async () => {
      const native = telemetry();
      instances.push(native);
      return {
        value: native,
        async release() {
          released++;
          await native.release();
        },
      };
    },
  });
  const api = expose({ run: () => success() });
  const definition = defineApplication({
    modules: [provideFlow([api]), observability],
  });
  const first = await runApplication(definition),
    second = await runApplication(definition);
  try {
    assert.notEqual(first.resolve(trace), second.resolve(trace));
    assert.equal(instances.length, 2);
    await Promise.all([first.resolve(api)({ input: undefined }), second.resolve(api)({ input: undefined })]);
    const one = instances[0]?.exporter.getFinishedSpans().find((span) => span.name === "openknot.expose");
    const two = instances[1]?.exporter.getFinishedSpans().find((span) => span.name === "openknot.expose");
    assert.ok(one && two);
    assert.notEqual(one.spanContext().traceId, two.spanContext().traceId);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
  assert.equal(released, 2);
});

test("a managed initializer waits for its explicit parents and leaves absent optional dependencies alone", async () => {
  let configured = 0;
  const dependency = unit({ factory: () => "native-configuration" });
  const absent = unit({ factory: () => assert.fail("an optional dependency must not be constructed") });
  const observability = provideOpenTelemetry({
    requirements: { dependency, diagnostics: optional(absent) },
    initialize: async ({ dependency, diagnostics }, { signal }) => {
      signal.throwIfAborted();
      assert.equal(dependency, "native-configuration");
      assert.equal(diagnostics, undefined);
      configured++;
      const native = telemetry();
      return { value: native, release: () => native.release() };
    },
  });
  const api = expose({ run: () => success(42) });
  const flow = provideFlow([api]);
  for (const modules of [
    [flow, observability],
    [flow, observability.when(false), providePlugs([dependency])],
  ]) {
    const app = await runApplication(defineApplication({ modules }));
    try {
      assert.equal(app.resolve(optional(trace)), undefined);
      assert.equal(configured, 0);
      assert.deepEqual(await app.resolve(api)({}), 42);
    } finally {
      await app.stop();
    }
  }
  const app = await runApplication(defineApplication({ modules: [observability, flow, providePlugs([dependency])] }));
  try {
    assert.ok(app.resolve(trace));
    assert.equal(configured, 1);
  } finally {
    await app.stop();
  }
});

test("managed SDK cleanup follows admitted work and flushes its completed spans once", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let released = 0;
  const observability = provideOpenTelemetry({
    initialize: async () => {
      const native = telemetry();
      return {
        value: native,
        async release() {
          released++;
          assert.equal(native.exporter.getFinishedSpans().filter((span) => span.name === "openknot.expose").length, 1);
          await native.release();
        },
      };
    },
  });
  const api = expose({
    run: async () => {
      entered.resolve();
      await finish.promise;
      return success(42);
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([api]), observability] }));
  const pending = app.resolve(api)({});
  try {
    await entered.promise;
    const stopping = app.stop();
    assert.equal(released, 0);
    finish.resolve();
    assert.equal(await pending, 42);
    await stopping;
    await app.stop();
    assert.equal(released, 1);
  } finally {
    finish.resolve();
    await pending;
    await app.stop();
  }
});

test("managed SDK resources unwind when a dependent singleton fails startup", async () => {
  const failure = new Error("application startup failed");
  let released = 0;
  const observability = provideOpenTelemetry({
    initialize: async () => {
      const native = telemetry();
      return {
        value: native,
        async release() {
          released++;
          await native.release();
        },
      };
    },
  });
  const broken = unit({
    requirements: { tracing: trace },
    factory: () => {
      throw failure;
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [observability, providePlugs([broken])] })),
    (error) => error === failure,
  );
  assert.equal(released, 1);
});

test("managed initializers receive startup cancellation and preserve acquisition failures", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<AbortSignal>();
  const observability = provideOpenTelemetry({
    initialize: async (_dependencies, { signal }) => {
      entered.resolve(signal);
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      assert.fail("cancelled initialization must not finish");
    },
  });
  const pending = runApplication(defineApplication({ modules: [observability] }), { signal: controller.signal });
  const signal = await entered.promise;
  const failure = new Error("cancelled startup");
  controller.abort(failure);
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, failure);

  const broken = provideOpenTelemetry({
    initialize: async () => {
      throw failure;
    },
  });
  await assert.rejects(runApplication(defineApplication({ modules: [broken] })), (error) => error === failure);
});

test("duplicate tracing modules fail before consumer SDK resources are acquired", async () => {
  let opened = 0;
  const sdk = resource({
    initialize: async () => {
      opened++;
      const native = telemetry();
      return { value: native, release: () => native.release() };
    },
  });
  const one = provideOpenTelemetry({ requirements: { sdk }, factory: ({ sdk }) => sdk });
  const two = provideOpenTelemetry({ requirements: { sdk }, factory: ({ sdk }) => sdk });
  await assert.rejects(
    runApplication(defineApplication({ modules: [providePlugs([sdk]), one, two] })),
    /multiple implementations supplied for/,
  );
  const managed = provideOpenTelemetry({
    initialize: async () => {
      opened++;
      const native = telemetry();
      return { value: native, release: () => native.release() };
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [managed, one, providePlugs([sdk])] })),
    /multiple implementations supplied for/,
  );
  assert.equal(opened, 0);
});

test("a stopped traced application releases its SDK once and keeps nothing reachable or scheduled", async () => {
  const gc = (globalThis as { gc?: () => void }).gc ?? assert.fail("run with node --expose-gc");
  // Only timers created from here on count: other tests' in-memory exporters schedule their own.
  const timers = new Set<number>();
  const watch = createHook({
    init(id, type) {
      if (type === "Timeout") {
        timers.add(id);
      }
    },
    destroy(id) {
      timers.delete(id);
    },
  }).enable();
  let released = 0;
  let exported = 0;
  const stopped = async () => {
    const observability = provideOpenTelemetry({
      initialize: async () => {
        const context = new AsyncLocalStorageContextManager().enable();
        const provider = new TracerProvider({
          spanProcessors: [
            new SimpleSpanProcessor({
              exporter: {
                export(spans, done) {
                  exported += spans.length;
                  done({ code: ExportResultCode.SUCCESS });
                },
                shutdown: async () => undefined,
              },
            }),
          ],
        });
        return {
          value: { tracer: provider.getTracer("lifecycle"), propagator: new W3CTraceContextPropagator(), context },
          async release() {
            released++;
            await provider.shutdown();
            context.disable();
          },
        };
      },
    });
    const work = command<number, number>()({ run: async (input) => success(input * 2) });
    const api = expose({ handler: work });
    const app = await runApplication(defineApplication({ modules: [provideFlow([api]), observability] }), {
      stopOn: [],
    });
    for (let input = 0; input < 20; input++) {
      assert.equal(await app.resolve(api)({ input }), input * 2);
    }
    await app.stop();
    return new WeakRef(app);
  };
  const application = await stopped();
  // The current job keeps its objects alive, and cleared timers report, until the next turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  watch.disable();
  assert.equal(released, 1);
  assert.ok(exported >= 60, `${exported} spans exported`);
  assert.equal(application.deref(), undefined);
  assert.equal(timers.size, 0);
});
