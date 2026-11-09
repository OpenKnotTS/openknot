import type { ErrorOf } from "@openknot-ts/behavior";
import type {
  ActorResolver,
  ExecutionActor,
  Exposure,
  ExposureComposition,
  ExposureDefinition,
  FlowExecutionError,
  GuardErrors,
  GuardInputs,
  Guards,
} from "@openknot-ts/flow";
import { isExposure, isExposureComposition } from "@openknot-ts/flow";
import { executionActorResolver } from "@openknot-ts/flow/wire";
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import type { OptionalDependency, UnitBinding } from "@openknot-ts/wire";
import { collect, optional, unit } from "@openknot-ts/wire";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export type RestMethod = "get" | "post" | "put" | "patch" | "delete";

const methods: readonly RestMethod[] = ["get", "post", "put", "patch", "delete"];

/** What a route's guard mapping reads from a request; credentials stay with the authentication. */
export interface RouteRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: RestHeaders;
}

/** Native header lookup, case-insensitive in both hosts. */
export interface RestHeaders {
  get(name: string): string | null | undefined;
}

export interface ErrorResponse {
  readonly status: number;
  readonly body?: unknown;
}

/** A status, answering `{ type, message }`, or a response built from the narrowed error. */
export type ErrorHandling<E> = number | ((error: E) => ErrorResponse);

/** The authored failures of an exposure: its handler's, its view's and its guards', without Flow's own. */
export type RouteErrors<P> =
  P extends Exposure<infer _I, infer _R, infer G, infer O>
    ? Exclude<ErrorOf<Awaited<O>> | GuardErrors<G>, FlowExecutionError>
    : never;

type ErrorType<E> = E extends { readonly type: infer T extends string } ? T : never;
type Handling<E, K> = ErrorHandling<Extract<E, { readonly type: K }>>;

type MethodField = {
  readonly [M in RestMethod]: { readonly [K in M]: string } & { readonly [K in Exclude<RestMethod, M>]?: never };
}[RestMethod];

type InputField<I> = [I] extends [void] ? { readonly input?: never } : { readonly input: StandardSchemaV1<unknown, I> };

type GuardsField<G extends Guards> =
  {} extends GuardInputs<G>
    ? { readonly guards?: (request: RouteRequest) => GuardInputs<G> }
    : { readonly guards: (request: RouteRequest) => GuardInputs<G> };

/** Every authored error has a status here or in the router; the route's entry wins. */
type ErrorsField<E, Mapped extends string> = [Exclude<ErrorType<E>, Mapped>] extends [never]
  ? { readonly errors?: { readonly [K in ErrorType<E>]?: Handling<E, K> } }
  : {
      readonly errors: { readonly [K in Exclude<ErrorType<E>, Mapped>]: Handling<E, K> } & {
        readonly [K in Extract<ErrorType<E>, Mapped>]?: Handling<E, K>;
      };
    };

/** One route: exactly one method key whose value is the path, beside the options its exposure requires. */
export type Route<P, Mapped extends string = never> =
  P extends Exposure<infer I, infer _R, infer G, infer _O>
    ? MethodField &
        InputField<I> &
        GuardsField<G> &
        ErrorsField<RouteErrors<P>, Mapped> & {
          readonly status?: number;
          readonly authenticate?: boolean;
          readonly output?: StandardSchemaV1;
        }
    : never;

type Members = Readonly<Record<string, ExposureDefinition>>;
type Port = ExposureDefinition | ExposureComposition;
/** A composition's members, or one exposure as the single member `route`. */
type PortMembers<T> = T extends ExposureComposition<infer M> ? M : { readonly route: T };
type PortErrors<T> = RouteErrors<PortMembers<T>[keyof PortMembers<T>]>;
/** As `plug()` binds one port or a composition: one route for an exposure, one per member for a composition. */
type PortRoutes<T, Mapped extends string> =
  T extends ExposureComposition<infer M> ? { readonly [K in keyof M]: Route<M[K], Mapped> } : Route<T, Mapped>;

export interface RestRoutesOptions<T extends Port, Mapped extends ErrorType<PortErrors<T>>> {
  readonly port: T;
  readonly authenticate?: boolean;
  readonly errors?: { readonly [K in Mapped]: Handling<PortErrors<T>, K> };
  readonly routes: PortRoutes<T, Mapped>;
}

type Invoke = (request: object) => Promise<unknown>;
type Segment = { readonly literal: string } | { readonly param: string };

export interface CompiledRoute {
  readonly name: string;
  readonly method: Uppercase<RestMethod>;
  readonly path: string;
  readonly segments: readonly Segment[];
  readonly params: readonly string[];
  readonly invoke: Invoke;
  readonly input: StandardSchemaV1 | undefined;
  readonly output: StandardSchemaV1 | undefined;
  readonly status: number;
  readonly guards: ((request: RouteRequest) => object) | undefined;
  readonly errors: ReadonlyMap<string, ErrorHandling<never>>;
  readonly resolve: ActorResolver<ExecutionActor> | undefined;
  readonly tracing: Tracing | undefined;
}

/** Only route sets listed by the selected modules join the router; dependencies do not. */
export const declaredRestRoutes = collect.contract<readonly CompiledRoute[]>();

type RestRoutesRequirements<P> = P & {
  readonly restTracing: OptionalDependency<typeof trace>;
  readonly restActorResolver: OptionalDependency<typeof executionActorResolver>;
};

export type RestRoutes<T extends Port> = UnitBinding<
  readonly CompiledRoute[],
  RestRoutesRequirements<PortMembers<T>>,
  typeof declaredRestRoutes
>;

const reservedMembers = new Set(["restTracing", "restActorResolver"]);
const routeKeys = new Set([...methods, "input", "output", "status", "guards", "errors", "authenticate"]);
const parameterName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !("~standard" in value)) {
    return false;
  }
  const standard: unknown = value["~standard"];
  return (
    typeof standard === "object" &&
    standard !== null &&
    "validate" in standard &&
    typeof standard.validate === "function"
  );
}

function segmentsOf(name: string, path: unknown): readonly Segment[] {
  if (typeof path !== "string" || !path.startsWith("/") || (path.length > 1 && path.endsWith("/"))) {
    throw new TypeError(`Route '${name}' needs a path that starts with / and does not end with /.`);
  }
  if (path === "/") {
    return [];
  }
  const seen = new Set<string>();
  return path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (segment === "") {
        throw new TypeError(`Route '${name}' has an empty path segment.`);
      }
      if (!segment.startsWith(":")) {
        return { literal: segment };
      }
      const param = segment.slice(1);
      if (!parameterName.test(param) || seen.has(param)) {
        throw new TypeError(`Route '${name}' has an invalid or repeated parameter ':${param}'.`);
      }
      seen.add(param);
      return { param };
    });
}

function errorsOf(owner: string, value: unknown): ReadonlyMap<string, ErrorHandling<never>> {
  if (value === undefined) {
    return new Map();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${owner} errors must be an object keyed by error type.`);
  }
  for (const [type, handling] of Object.entries(value)) {
    const status = typeof handling === "number" && Number.isInteger(handling) && handling >= 400 && handling <= 599;
    if (!status && typeof handling !== "function") {
      throw new TypeError(`${owner} maps '${type}' to neither a 4xx/5xx status nor a function.`);
    }
  }
  return new Map(Object.entries(value) as [string, ErrorHandling<never>][]);
}

type RouteSpec = Omit<CompiledRoute, "invoke" | "resolve" | "tracing"> & { readonly authenticate: boolean };

function specOf(
  name: string,
  route: unknown,
  router: { readonly authenticate: boolean; readonly errors: ReadonlyMap<string, ErrorHandling<never>> },
): RouteSpec {
  if (typeof route !== "object" || route === null || Array.isArray(route)) {
    throw new TypeError(`Route '${name}' must be an object.`);
  }
  const fields = route as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(fields)) {
    if (!routeKeys.has(key)) {
      throw new TypeError(`Route '${name}' has an unknown option '${key}'.`);
    }
  }
  const declared = methods.filter((method) => method in fields);
  if (declared.length !== 1) {
    throw new TypeError(`Route '${name}' needs exactly one of ${methods.join(", ")}.`);
  }
  const method = declared[0]!;
  const path = fields[method] as string;
  const segments = segmentsOf(name, path);
  const params = segments.flatMap((segment) => ("param" in segment ? [segment.param] : []));
  const { input, output, status = 200, guards, authenticate = router.authenticate } = fields;

  if (input !== undefined && !isStandardSchema(input)) {
    throw new TypeError(`Route '${name}' input must be a Standard Schema.`);
  }
  if (input === undefined && params.length > 0) {
    throw new TypeError(`Route '${name}' has path parameters but no input schema to receive them.`);
  }
  if (output !== undefined && !isStandardSchema(output)) {
    throw new TypeError(`Route '${name}' output must be a Standard Schema.`);
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 299) {
    throw new TypeError(`Route '${name}' status must be a 2xx integer.`);
  }
  if (guards !== undefined && typeof guards !== "function") {
    throw new TypeError(`Route '${name}' guards must be a function of the request.`);
  }
  if (typeof authenticate !== "boolean") {
    throw new TypeError(`Route '${name}' authenticate must be a boolean.`);
  }

  return {
    name,
    method: method.toUpperCase() as Uppercase<RestMethod>,
    path,
    segments,
    params,
    input,
    output,
    status,
    guards: guards as CompiledRoute["guards"],
    errors: new Map([...router.errors, ...errorsOf(`Route '${name}'`, fields.errors)]),
    authenticate,
  };
}

/**
 * REST routes over one exposure or a composition, as `plug()` binds one port or a composition: one route per
 * exposure, checked against it. The selected route sets join the router an HTTP adapter serves.
 */
export function restRoutes<const T extends Port, const Mapped extends ErrorType<PortErrors<T>> = never>(
  options: RestRoutesOptions<T, Mapped>,
): RestRoutes<T> {
  const { port, authenticate = false, errors } = options;
  const single = isExposure(port);

  if (!single && !isExposureComposition(port)) {
    throw new TypeError("restRoutes() port must be an exposure or an expose.compose() composition.");
  }
  const routes: unknown = single ? { route: options.routes } : options.routes;
  if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
    throw new TypeError("restRoutes() routes must be an object keyed by the composition's members.");
  }
  const members: Members = single ? { route: port } : (port.members as Members);
  const names = Object.keys(members);
  for (const name of names) {
    if (reservedMembers.has(name)) {
      throw new TypeError(`restRoutes() member name '${name}' is reserved.`);
    }
    if (!(name in routes)) {
      throw new TypeError(`restRoutes() has no route for '${name}'.`);
    }
  }
  for (const name of Object.keys(routes)) {
    if (!(name in members)) {
      throw new TypeError(`restRoutes() route '${name}' is not a member of the composition.`);
    }
  }
  if (typeof authenticate !== "boolean") {
    throw new TypeError("restRoutes() authenticate must be a boolean.");
  }
  const router = { authenticate, errors: errorsOf("restRoutes()", errors) };
  const declared = routes as Readonly<Record<string, unknown>>;
  const specs = names.map((name) => specOf(name, declared[name], router));

  return unit({
    provides: declaredRestRoutes,
    requirements: {
      ...members,
      restTracing: optional(trace),
      restActorResolver: optional(executionActorResolver),
    } as RestRoutesRequirements<PortMembers<T>>,
    factory: (dependencies) => {
      const resolved = dependencies as Readonly<Record<string, unknown>>;
      const resolve = resolved.restActorResolver as ActorResolver<ExecutionActor> | undefined;
      const tracing = resolved.restTracing as Tracing | undefined;
      return Object.freeze(
        specs.map(({ authenticate: authenticated, ...spec }) => {
          if (authenticated && resolve === undefined) {
            throw new TypeError(`Route '${spec.name}' authenticates, but no executionActorResolver is bound.`);
          }
          return Object.freeze({
            ...spec,
            invoke: resolved[spec.name] as Invoke,
            resolve: authenticated ? resolve : undefined,
            tracing,
          });
        }),
      );
    },
  });
}
