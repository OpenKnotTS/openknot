import { pinoLogging } from "./index.ts";
import type { Logging } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import type {
  NoRequirements,
  ProvidedPlugs,
  Provider,
  Requirements,
  RequirementsOptions,
  ResolvedReferences,
} from "@openknot-ts/wire";
import { providePlugs, unit } from "@openknot-ts/wire";
import type { Logger } from "pino";

export type PinoLoggingOptions<R extends Requirements = NoRequirements> = RequirementsOptions<R> & {
  readonly factory: (dependencies: ResolvedReferences<R>) => Logger;
};

/**
 * The module's compile-time graph: it implements `logging` and adds no needs, because its binding is conditional
 * and its requirements only decide whether it applies. The application's own check stays in force.
 */
export type PinoLoggingModule = ProvidedPlugs<never, typeof logging>;

/** Replaces the console default with the application's pino instance. */
export function providePinoLogging<const R extends Requirements = NoRequirements>(
  options: PinoLoggingOptions<R>,
): PinoLoggingModule;

export function providePinoLogging<const R extends Requirements>(options: PinoLoggingOptions<R>): ProvidedPlugs {
  const factory = options.factory;

  if (typeof factory !== "function") {
    throw new TypeError("providePinoLogging() requires factory().");
  }

  const binding: Provider<Logging, never, "unit"> = unit({
    provides: logging,
    whenAvailable: true,
    requirements: options.requirements ?? ({} as R),
    factory: (dependencies: ResolvedReferences<R>) => pinoLogging(factory(dependencies)),
  });

  return providePlugs([binding]);
}
