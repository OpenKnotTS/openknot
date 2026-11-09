import type {
  ApplicationStatus,
  NoRequirements,
  Provider,
  Requirements,
  RequirementsOptions,
  ResolvedReferences,
} from "@openknot-ts/wire";
import { applicationStatus, collect, composeModule, unit } from "@openknot-ts/wire";

export type HealthStatus = "up" | "down";

export interface HealthCheckOptions {
  /** Ends with the caller's request; a check should release its native work when it aborts. */
  readonly signal: AbortSignal;
}

/** One named dependency check, such as a database ping or a broker connection. */
export interface HealthCheck {
  readonly name: string;
  /** How long the check may take; a check that has not settled by then counts as down. */
  readonly timeoutMs?: number;
  check(options: HealthCheckOptions): Promise<HealthStatus>;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly application: ApplicationStatus;
  readonly checks: Readonly<Record<string, HealthStatus>>;
}

export interface HealthProbes {
  /** Up while the application can serve; checks never affect it, so their outages cause no restarts. */
  liveness(): HealthStatus;
  /** Up only while the application is ready: down during startup and from the moment stopping begins. */
  readiness(): HealthStatus;
  /** Readiness combined with every check, which run concurrently; a check that rejects counts as down. */
  health(options: HealthCheckOptions): Promise<HealthReport>;
}

/** Every health check the application's selected modules list. */
export const healthChecks = collect.contract<HealthCheck>();

export type HealthCheckDefinition<R extends Requirements = NoRequirements> = Provider<
  HealthCheck,
  ResolvedReferences<R>,
  "unit",
  R
> & { readonly provides: typeof healthChecks };

/** How long a check may take unless it declares otherwise. */
const defaultTimeoutMs = 1_000;

/** Declares a check next to the resource it checks; listing it in a module adds it to the application's health. */
export function healthCheck<const R extends Requirements = NoRequirements>(
  options: RequirementsOptions<R> & {
    readonly name: string;
    /** Defaults to one second. */
    readonly timeoutMs?: number;
    readonly check: (dependencies: ResolvedReferences<R>, options: HealthCheckOptions) => Promise<HealthStatus>;
  },
): HealthCheckDefinition<R> {
  const { name, check, timeoutMs = defaultTimeoutMs } = options;

  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("healthCheck() requires a name.");
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`Health check '${name}' requires a positive integer timeoutMs.`);
  }

  if (typeof check !== "function") {
    throw new TypeError(`Health check '${name}' requires a check function.`);
  }

  return unit({
    provides: healthChecks,
    requirements: options.requirements ?? ({} as R),
    // A check is built only when the application selects the health probes.
    whenAvailable: [healthProbes],
    factory: (dependencies: ResolvedReferences<R>): HealthCheck =>
      Object.freeze({
        name,
        timeoutMs,
        check: (checkOptions: HealthCheckOptions) => check(dependencies, checkOptions),
      }),
  });
}

/**
 * Runs one check under its deadline. This deadline is the framework's one application timer: a dependency that holds
 * a request without answering must not hold the probe, and the check's signal aborts so it can release native work.
 */
async function run(check: HealthCheck, options: HealthCheckOptions): Promise<HealthStatus> {
  const deadline = new AbortController();
  const timedOut = Promise.withResolvers<HealthStatus>();
  const timer = setTimeout(() => {
    deadline.abort(new Error(`Health check '${check.name}' timed out`));
    timedOut.resolve("down");
  }, check.timeoutMs ?? defaultTimeoutMs);
  try {
    // A check that throws before returning its promise reports down like one that rejects.
    const checked = (async () => check.check({ signal: AbortSignal.any([options.signal, deadline.signal]) }))().then(
      (status): HealthStatus => (status === "up" ? "up" : "down"),
      (): HealthStatus => "down",
    );
    return await Promise.race([checked, timedOut.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export const healthProbes = unit({
  requirements: { applicationStatus, healthChecks },
  factory: ({ applicationStatus, healthChecks }): HealthProbes => {
    const names = new Set<string>();

    for (const { name } of healthChecks) {
      if (names.has(name)) {
        throw new TypeError(`Health check '${name}' is declared more than once.`);
      }
      names.add(name);
    }

    return Object.freeze({
      liveness: () => (applicationStatus() === "stopped" ? "down" : "up"),
      readiness: () => (applicationStatus() === "ready" ? "up" : "down"),
      async health(options: HealthCheckOptions): Promise<HealthReport> {
        const results = await Promise.all(
          healthChecks.map(async (check) => [check.name, await run(check, options)] as const),
        );
        // Read after the checks, so the report reflects a stop that began while they ran.
        const application = applicationStatus();
        const up = application === "ready" && results.every(([, status]) => status === "up");
        return Object.freeze({
          status: up ? "up" : "down",
          application,
          checks: Object.freeze(Object.fromEntries(results)),
        });
      },
    });
  },
});

/** Health semantics only; transport adapters expose the probes through their own native contracts. */
export const health = composeModule({ providers: { healthProbes } });
