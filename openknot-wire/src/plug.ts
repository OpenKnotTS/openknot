import { hasMarker } from "./internal/marker.ts";
import type { NoRequirements, RequirementsOptions } from "./internal/requirements.ts";
import { snapshotRequirements } from "./internal/requirements.ts";
import type { Requirements } from "./providers.ts";

export const PlugMarker = Symbol.for("@openknot-ts/wire/plug");

export interface PlugHandle {
  release(): void | Promise<void>;
}

export interface PlugDefinition {
  readonly [PlugMarker]: true;
  readonly kind: "plug";
  readonly port: object;
  readonly requirements: Requirements;
  readonly bind: (ctx: never) => unknown;
  /** Port integrations own and interpret the immutable extension options. */
  readonly options: Readonly<Record<string, unknown>>;
}

export interface Plug<P extends object = object, R extends Requirements = NoRequirements> extends PlugDefinition {
  readonly port: P;
  readonly requirements: R;
}

/** Optional port integrations contribute their typed declaration signatures. */
export interface PlugOptions<_P extends object, _R extends Requirements> {}
export interface PlugFactory {
  <const P extends object, const R extends Requirements = NoRequirements>(
    options: RequirementsOptions<R> & { readonly port: P } & PlugOptions<NoInfer<P>, NoInfer<R>>[keyof PlugOptions<
        NoInfer<P>,
        NoInfer<R>
      >],
  ): Plug<P, NoInfer<R>>;
}

function declarePlug(
  options: RequirementsOptions<Requirements> & {
    readonly port: object;
    readonly bind: (ctx: never) => unknown;
  },
): PlugDefinition {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("A plug requires { port, bind, requirements? }");
  }

  const bind = options.bind;
  const declaredPort = options.port;

  if (typeof bind !== "function") {
    throw new TypeError("A plug requires { port, bind, requirements? }");
  }

  if (typeof declaredPort !== "object" || declaredPort === null || Array.isArray(declaredPort)) {
    throw new TypeError("A plug requires one port or an explicit port composition");
  }

  const requirements = snapshotRequirements(options.requirements);

  if ("port" in requirements) {
    throw new TypeError("Reserved requirement name: port");
  }

  const extension = Object.freeze(
    Object.fromEntries(
      Object.keys(options)
        .filter((key) => !["port", "requirements", "bind"].includes(key))
        .map((key) => [key, Reflect.get(options, key)]),
    ),
  );

  return Object.freeze({
    options: extension,
    [PlugMarker]: true as const,
    kind: "plug" as const,
    port: declaredPort,
    requirements,
    bind,
  });
}

export const plug = declarePlug as PlugFactory;

export function isPlug(value: unknown): value is PlugDefinition {
  return hasMarker(value, PlugMarker);
}
