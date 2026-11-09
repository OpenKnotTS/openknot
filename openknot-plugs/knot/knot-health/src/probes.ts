import type { HealthStatus, healthProbes } from "@openknot-ts/health";
import type { Resolved, Requirements, RequirementsOptions, ResolvedReferences } from "@openknot-ts/wire";
import { config, unit } from "@openknot-ts/wire";
import { z } from "zod";

const path = z.string().startsWith("/", "must start with /");

/** These settings are reachable only when an adapter is selected. */
export const healthHttpConfig = config({
  HTTP_LIVENESS_PATH: path.default("/livez"),
  HTTP_READINESS_PATH: path.default("/readyz"),
  HTTP_HEALTH_PATH: path.default("/health"),
});

export interface ProbePaths {
  readonly liveness: string;
  readonly readiness: string;
  readonly health: string;
}

export type ProbeOptions<R extends Requirements = {}> = RequirementsOptions<R> & {
  readonly paths?: (dependencies: ResolvedReferences<R>) => ProbePaths;
};

/** Explicit paths select only their own config requirements; omitted paths retain the ready defaults. */
export function probeSettings<const R extends Requirements = {}>(options: ProbeOptions<R> = {} as ProbeOptions<R>) {
  const requirements = {
    ...options.requirements,
    ...(options.paths === undefined ? { __settings: healthHttpConfig } : {}),
  } as R;
  return unit({
    requirements,
    factory: (dependencies): ProbePaths => {
      if (options.paths !== undefined) {
        return options.paths(dependencies);
      }
      const settings = (dependencies as { readonly __settings: Resolved<typeof healthHttpConfig> }).__settings;
      return {
        liveness: settings.HTTP_LIVENESS_PATH,
        readiness: settings.HTTP_READINESS_PATH,
        health: settings.HTTP_HEALTH_PATH,
      };
    },
  });
}
export type Probe = (signal: AbortSignal) => HealthStatus | Promise<HealthStatus>;

/** The public body and headers of a probe answer; HEAD sends the headers only. */
export function probeAnswer(status: HealthStatus) {
  const body = status === "up" ? '{"status":"up"}' : '{"status":"down"}';
  return {
    status: status === "up" ? 200 : 503,
    body,
    headers: { "content-type": "application/json", "cache-control": "no-store", "content-length": String(body.length) },
  };
}

/** Probes answer GET and HEAD only; other methods reach the next handler. */
export const isProbeMethod = (method: string): boolean => method === "GET" || method === "HEAD";

/** The probe each configured path answers; the three paths must differ. */
export function probeRoutes(health: Resolved<typeof healthProbes>, settings: ProbePaths): ReadonlyMap<string, Probe> {
  const routes = new Map<string, Probe>([
    [settings.liveness, () => health.liveness()],
    [settings.readiness, () => health.readiness()],
    [settings.health, async (signal) => (await health.health({ signal })).status],
  ]);

  if (routes.size !== 3) {
    throw new Error("HTTP_LIVENESS_PATH, HTTP_READINESS_PATH and HTTP_HEALTH_PATH must differ.");
  }
  if ([...routes.keys()].some((path) => !path.startsWith("/"))) {
    throw new TypeError("Health probe paths must start with /.");
  }

  return routes;
}
