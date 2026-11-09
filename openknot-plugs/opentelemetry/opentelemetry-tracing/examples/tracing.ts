import { provideOpenTelemetry } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { command, expose, listener, publisher, query, scheduler } from "@openknot-ts/flow";
import type { PublishOptions } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { composeModule, defineApplication, runApplication, plug } from "@openknot-ts/wire";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { ConsoleSpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

// The application creates and releases its own SDK instances; the module wires them in.
const observability = provideOpenTelemetry({
  initialize: async (_dependencies, { signal }) => {
    signal.throwIfAborted();

    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() })],
    });
    const context = new AsyncLocalStorageContextManager().enable();

    return {
      value: {
        tracer: provider.getTracer("@openknot-ts/flow", "0.1.0"),
        context,
        propagator: new W3CTraceContextPropagator(),
      },
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

// A publisher whose plug keeps the propagation carrier it receives
const events = publisher<number>();
let delivery: PublishOptions = {};

const sending = plug({
  port: events,
  bind: () => (_event, options) => {
    delivery = { propagation: options.propagation };
  },
});

// An exposure, a listener and a scheduler, each traced
const change = command({
  requirements: { events },
  run: async (_, ctx) => {
    await ctx.events.publish(1);
    return success();
  },
});

const api = expose({ handler: change });
const inspect = query({ run: (_, ctx) => success(ctx.actor) });
const onEvent = listener({ handler: inspect });
const tick = scheduler({ handler: inspect, schedule: { every: { minutes: 1 } } });

const app = await runApplication(
  defineApplication({
    modules: [provideFlow([api, onEvent, tick]), composeModule({ providers: { sending } }), observability],
  }),
);

try {
  console.log(await app.resolve(api)({ input: undefined, actor: "alice" }));
  console.log(await app.resolve(onEvent)({ input: undefined, ...delivery }));

  // Invoke one scheduled tick directly; a real timer plug calls the same invoker.
  console.log(await app.resolve(tick)({ trigger: { scheduledAt: Date.now() } }));
} finally {
  await app.stop();
}
