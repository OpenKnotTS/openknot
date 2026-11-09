import type { OpenTelemetryTracingOptions } from "@openknot-ts/opentelemetry-tracing";
import { provideOpenTelemetry } from "@openknot-ts/opentelemetry-tracing/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";

declare const native: OpenTelemetryTracingOptions;
const settings = unit({ factory: () => ({ scope: "application" }) });

provideOpenTelemetry({
  requirements: { settings },
  initialize: async ({ settings }, { signal }) => {
    const scope: string = settings.scope;
    void scope;
    signal.throwIfAborted();
    // @ts-expect-error Only declared dependencies are available.
    void settings.missing;
    return { value: { ...native, consumerParent: "parent" }, release() {} };
  },
});

provideOpenTelemetry({
  requirements: { settings },
  factory: ({ settings }) => ({ ...native, consumerParent: settings.scope === "application" ? "link" : "parent" }),
});

// @ts-expect-error A managed initializer must provide its SDK cleanup.
provideOpenTelemetry({ initialize: async () => ({ value: native }) });

// @ts-expect-error Native tracing contracts must be returned, not an arbitrary SDK object.
provideOpenTelemetry({ initialize: async () => ({ value: { sdk: true }, release() {} }) });

// @ts-expect-error A module chooses exactly one lifecycle owner.
provideOpenTelemetry({ factory: () => native, initialize: async () => ({ value: native, release() {} }) });

const required = unit.contract<string>();
const consumer = unit({ requirements: { required }, factory: ({ required }) => required });
for (const telemetry of [
  provideOpenTelemetry({ factory: () => native }),
  provideOpenTelemetry({ initialize: async () => ({ value: native, release() {} }) }),
]) {
  const application = defineApplication({ modules: [composeModule({ providers: { consumer } }), telemetry] });
  // @ts-expect-error The telemetry module keeps the application's check: the required contract has no implementation.
  void runApplication(application);
}
