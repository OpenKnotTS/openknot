import type { OpenTelemetryTracingOptions } from "./index.ts";
import { openTelemetryTracing } from "./index.ts";
import type { TraceSpan, Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { providePlugs, resource, unit } from "@openknot-ts/wire";
import type {
  CancellationOptions,
  ManagedResource,
  NoRequirements,
  ProvidedPlugs,
  Provider,
  Requirements,
  RequirementsOptions,
  ResourceHandle,
  ResolvedReferences,
} from "@openknot-ts/wire";

export type OpenTelemetryModuleOptions<R extends Requirements = NoRequirements> = RequirementsOptions<R> & {
  readonly factory: (dependencies: ResolvedReferences<R>) => OpenTelemetryTracingOptions;
};

/** Acquires consumer-selected SDK instances; Wire runs the returned release after execution drains. */
export type OpenTelemetryResourceOptions<R extends Requirements = NoRequirements> = RequirementsOptions<R> & {
  readonly initialize: (
    dependencies: ResolvedReferences<R>,
    options: CancellationOptions,
  ) => Promise<ResourceHandle<OpenTelemetryTracingOptions>>;
};

interface ManagedTelemetry {
  readonly options: OpenTelemetryTracingOptions;
  readonly active: Set<Promise<unknown>>;
}

/**
 * The module's compile-time graph: it implements `trace` and adds no needs, because its bindings are conditional
 * and their requirements only decide whether they apply. The application's own check stays in force.
 */
export type OpenTelemetryModule = ProvidedPlugs<never, typeof trace>;

/** Connects SDK instances whose lifecycle is already managed elsewhere. */
export function provideOpenTelemetry<const R extends Requirements = NoRequirements>(
  options: OpenTelemetryModuleOptions<R>,
): OpenTelemetryModule;

/** Owns the resource declaration, tracing binding and provision as one application module. */
export function provideOpenTelemetry<const R extends Requirements = NoRequirements>(
  options: OpenTelemetryResourceOptions<R>,
): OpenTelemetryModule;

export function provideOpenTelemetry<const R extends Requirements = NoRequirements>(
  options: OpenTelemetryResourceOptions<R> | OpenTelemetryModuleOptions<R>,
): ProvidedPlugs {
  if ("initialize" in options) {
    if ("factory" in options) {
      throw new TypeError("provideOpenTelemetry() accepts either initialize() or factory().");
    }

    if (typeof options.initialize !== "function") {
      throw new TypeError("provideOpenTelemetry() requires initialize().");
    }

    // Generic requirements are validated at startup, as in the externally managed factory form below.
    const initialize = options.initialize;
    const telemetry: Provider<ManagedResource<ManagedTelemetry>, never, "resource"> = resource({
      requirements: options.requirements === undefined ? ({} as R) : options.requirements,
      whenAvailable: true,
      initialize: async (dependencies: ResolvedReferences<R>, options) => {
        const handle = await initialize(dependencies, options);
        if (
          typeof handle !== "object" ||
          handle === null ||
          !("value" in handle) ||
          typeof handle.release !== "function"
        ) {
          throw new TypeError("provideOpenTelemetry() initialize() must return { value, release() }.");
        }
        const active = new Set<Promise<unknown>>();
        return {
          value: { options: handle.value, active },
          async release() {
            // An input span also covers its scope's cleanup, so it may finish after Wire drains that scope.
            await Promise.allSettled(active);
            await handle.release();
          },
        };
      },
    });

    const tracing = unit({
      provides: trace,
      requirements: { telemetry },
      whenAvailable: true,
      factory: ({ telemetry }) => {
        const tracing = openTelemetryTracing(telemetry.options);
        const active = telemetry.active;
        return Object.freeze({
          ...tracing,
          run<T>(span: TraceSpan, work: () => Promise<T>): Promise<T> {
            const pending = tracing.run(span, work);
            active.add(pending);
            void pending.then(
              () => active.delete(pending),
              () => active.delete(pending),
            );
            return pending;
          },
        });
      },
    });

    return providePlugs([telemetry, tracing]);
  }

  const factory = options.factory;

  if (typeof factory !== "function") {
    throw new TypeError("provideOpenTelemetry() requires factory().");
  }

  // Generic requirements are known only to startup validation, so the unit carries no compile-time graph.
  const tracing: Provider<Tracing, never, "unit"> = unit({
    provides: trace,
    requirements: options.requirements === undefined ? ({} as R) : options.requirements,
    whenAvailable: true,
    factory: (dependencies: ResolvedReferences<R>) => openTelemetryTracing(factory(dependencies)),
  });

  return providePlugs([tracing]);
}
