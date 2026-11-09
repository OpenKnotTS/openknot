import type { CompiledRoute, RestHeaders, RouteRequest } from "./routes.ts";
import { declaredRestRoutes } from "./routes.ts";
import { error } from "@openknot-ts/behavior";
import { ActorAuthenticationError, InputCancelledError, InputUnavailableError } from "@openknot-ts/flow";
import { propagationFields } from "@openknot-ts/tracing";
import { VersionConflict } from "@openknot-ts/versioning";
import { config, unit } from "@openknot-ts/wire";
import type { Requirements, RequirementsOptions, Resolved, ResolvedReferences } from "@openknot-ts/wire";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

/** Adapters read bodies up to this many bytes, 1 MiB unless REST_MAX_BODY_SIZE says otherwise. */
export const restConfig = config({
  REST_MAX_BODY_SIZE: z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(z.int().min(0))
    .default(1_048_576),
});

export type RestBodyOptions<R extends Requirements = {}> = RequirementsOptions<R> & {
  readonly maxBodySize?: (dependencies: ResolvedReferences<R>) => number;
};

/** An explicit body limit consumes only its declared config; defaults retain REST_MAX_BODY_SIZE. */
export function restBodyLimit<const R extends Requirements = {}>(
  options: RestBodyOptions<R> = {} as RestBodyOptions<R>,
) {
  return unit({
    requirements: {
      ...options.requirements,
      ...(options.maxBodySize === undefined ? { __settings: restConfig } : {}),
    } as R,
    factory: (dependencies) => {
      const limit =
        options.maxBodySize === undefined
          ? (dependencies as { readonly __settings: Resolved<typeof restConfig> }).__settings.REST_MAX_BODY_SIZE
          : options.maxBodySize(dependencies);
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new TypeError("REST maxBodySize must be a non-negative safe integer.");
      }
      return limit;
    },
  });
}

/** What an adapter reads natively from its host's request. */
export interface RestRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: RestHeaders;
  /** Reads and parses the JSON body; called only by routes that take a body. */
  readonly readBody: () => Promise<unknown>;
  /** Aborts only when the client goes away, so admitted requests drain while the host stops. */
  readonly signal: AbortSignal;
}

/** What an adapter writes natively; a body is already serialized JSON. */
export interface RestResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** An adapter's body failure: 400 for malformed JSON, 413 above its limit, 415 for another content type. */
export const RestBodyError = error("RestBodyError", (status: 400 | 413 | 415, message: string) => ({
  message,
  status,
}));
export interface RestBodyError extends ReturnType<typeof RestBodyError> {}

const jsonContentType = /^application\/json\s*(;|$)/i;

/** Header lookup over a Node-style header record, as Node's and Fastify's requests carry it. */
export function restHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>>): RestHeaders {
  return {
    get: (name) => {
      const value = headers[name.toLowerCase()];
      return typeof value === "string" || value === undefined ? value : value.join(", ");
    },
  };
}

/**
 * Reads a JSON body of at most `limit` bytes from the host's native byte stream, rejecting with `RestBodyError`
 * before a declared length above the limit is read and as soon as the bytes read exceed it.
 */
export async function readJsonBody(
  headers: RestHeaders,
  chunks: AsyncIterable<Uint8Array> | null,
  limit: number,
): Promise<unknown> {
  if (!jsonContentType.test(headers.get("content-type") ?? "")) {
    throw RestBodyError(415, "The body must be application/json.");
  }
  if (Number(headers.get("content-length") ?? 0) > limit) {
    throw RestBodyError(413, "The body is too large.");
  }
  // Decoded as it arrives; a streaming decoder keeps characters split across chunks whole.
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for await (const chunk of chunks ?? []) {
    size += chunk.byteLength;
    if (size > limit) {
      throw RestBodyError(413, "The body is too large.");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw RestBodyError(400, "The body is not valid JSON.");
  }
}

export interface RestRouter {
  handle(request: RestRequest): Promise<RestResponse>;
}

interface Issue {
  readonly message: string;
  readonly path?: readonly string[];
}

const InvalidInput = error("InvalidInput", (message: string, issues?: readonly Issue[]) => ({
  message,
  ...(issues === undefined ? {} : { issues }),
}));

const bodyMethods = new Set(["POST", "PUT", "PATCH"]);
const bearer = /^Bearer[ \t]+(\S+)$/i;

interface Node {
  readonly literals: Map<string, Node>;
  param: { readonly name: string; readonly node: Node } | undefined;
  readonly routes: Map<string, CompiledRoute>;
}

function node(): Node {
  return { literals: new Map(), param: undefined, routes: new Map() };
}

function insert(root: Node, route: CompiledRoute): void {
  let current = root;
  for (const segment of route.segments) {
    if ("literal" in segment) {
      let next = current.literals.get(segment.literal);
      if (next === undefined) {
        next = node();
        current.literals.set(segment.literal, next);
      }
      current = next;
    } else {
      if (current.param !== undefined && current.param.name !== segment.param) {
        throw new TypeError(
          `REST route '${route.name}' names ':${segment.param}' where another route names ':${current.param.name}'.`,
        );
      }
      current.param ??= { name: segment.param, node: node() };
      current = current.param.node;
    }
  }
  const existing = current.routes.get(route.method);
  if (existing !== undefined) {
    throw new TypeError(`REST routes '${existing.name}' and '${route.name}' both serve ${route.method} ${route.path}.`);
  }
  current.routes.set(route.method, route);
}

type Candidate = { readonly node: Node; readonly params: Readonly<Record<string, string>> };

/** Every node the path reaches, literal segments before parameters. */
function candidates(
  current: Node,
  segments: readonly string[],
  index: number,
  params: Record<string, string>,
): Candidate[] {
  if (index === segments.length) {
    return current.routes.size === 0 ? [] : [{ node: current, params: { ...params } }];
  }
  const segment = segments[index]!;
  const found: Candidate[] = [];
  const literal = current.literals.get(segment);
  if (literal !== undefined) {
    found.push(...candidates(literal, segments, index + 1, params));
  }
  if (current.param !== undefined) {
    found.push(...candidates(current.param.node, segments, index + 1, { ...params, [current.param.name]: segment }));
  }
  return found;
}

function json(status: number, body: unknown): RestResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function queryOf(query: URLSearchParams): Readonly<Record<string, string | readonly string[]>> {
  const values: Record<string, string | readonly string[]> = {};
  for (const key of new Set(query.keys())) {
    const all = query.getAll(key);
    values[key] = all.length === 1 ? all[0]! : all;
  }
  return values;
}

function issuesOf(issues: readonly StandardSchemaV1.Issue[]): readonly Issue[] {
  return issues.map(({ message, path }) =>
    path === undefined
      ? { message }
      : { message, path: path.map((segment) => String(typeof segment === "object" ? segment.key : segment)) },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inputOf(
  route: CompiledRoute,
  schema: StandardSchemaV1,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, unknown>>,
  request: RestRequest,
): Promise<unknown> {
  const source = bodyMethods.has(route.method) ? await request.readBody() : query;
  let data = source;
  if (route.params.length > 0) {
    if (!isRecord(source)) {
      throw InvalidInput("A route with path parameters takes a JSON object.");
    }
    const shared = route.params.filter((name) => name in source);
    if (shared.length > 0) {
      throw InvalidInput(`'${shared.join("', '")}' is both a path parameter and a request field.`);
    }
    data = { ...params, ...source };
  }
  const result = await schema["~standard"].validate(data);
  if (result.issues !== undefined) {
    throw InvalidInput("The input is invalid.", issuesOf(result.issues));
  }
  return result.value;
}

async function actorOf(route: CompiledRoute, request: RestRequest): Promise<unknown> {
  if (route.resolve === undefined) {
    return undefined;
  }
  const token = bearer.exec(request.headers.get("authorization") ?? "")?.[1];
  if (token === undefined) {
    throw ActorAuthenticationError();
  }
  const actor = await route.resolve(token, { signal: request.signal });
  if (actor === undefined || actor === null) {
    throw ActorAuthenticationError();
  }
  return actor;
}

function propagationOf(route: CompiledRoute, headers: RestHeaders): Readonly<Record<string, string>> | undefined {
  if (route.tracing === undefined) {
    return undefined;
  }
  const carrier: Record<string, string> = {};
  for (const name of propagationFields(route.tracing)) {
    const value = headers.get(name);
    if (typeof value === "string") {
      carrier[name] = value;
    }
  }
  return carrier;
}

async function respond(
  route: CompiledRoute,
  params: Readonly<Record<string, string>>,
  request: RestRequest,
): Promise<RestResponse> {
  const query = queryOf(request.query);
  const view: RouteRequest = { params, query, headers: request.headers };
  const actor = await actorOf(route, request);
  const input = route.input === undefined ? undefined : await inputOf(route, route.input, params, query, request);
  let value = await route.invoke({
    ...route.guards?.(view),
    input,
    signal: request.signal,
    actor,
    propagation: propagationOf(route, request.headers),
    traceAttributes: { "http.request.method": route.method, "http.route": route.path },
  });
  if (route.output !== undefined) {
    const result = await route.output["~standard"].validate(value);
    if (result.issues !== undefined) {
      throw new TypeError(`REST route '${route.name}' answered a value its output schema rejects.`);
    }
    value = result.value;
  }
  return value === undefined ? { status: 204 } : json(route.status, value);
}

function failed(route: CompiledRoute, cause: unknown): RestResponse {
  if (RestBodyError.is(cause)) {
    return cause.status === 400
      ? json(400, { type: "InvalidInput", message: cause.message })
      : { status: cause.status };
  }
  if (InvalidInput.is(cause)) {
    return json(400, {
      type: cause.type,
      message: cause.message,
      ...("issues" in cause ? { issues: cause.issues } : {}),
    });
  }
  if (ActorAuthenticationError.is(cause) || VersionConflict.is(cause)) {
    return json(ActorAuthenticationError.is(cause) ? 401 : 409, { type: cause.type, message: cause.message });
  }
  if (InputCancelledError.is(cause)) {
    return { status: 499 };
  }
  if (InputUnavailableError.is(cause)) {
    return { status: 503 };
  }
  const type = isRecord(cause) && typeof cause.type === "string" ? cause.type : undefined;
  const handling = type === undefined ? undefined : route.errors.get(type);
  if (typeof handling === "number") {
    return json(handling, { type, message: (cause as Error).message });
  }
  if (handling !== undefined) {
    const { status, body } = handling(cause as never);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError(`REST route '${route.name}' mapped '${type}' to an invalid status.`);
    }
    return body === undefined ? { status } : json(status, body);
  }
  return json(500, { type: "InternalError" });
}

function createRouter(routes: readonly CompiledRoute[]): RestRouter {
  const root = node();
  for (const route of routes) {
    insert(root, route);
  }

  return Object.freeze({
    async handle(request: RestRequest): Promise<RestResponse> {
      let segments: string[];
      try {
        segments = request.path === "/" ? [] : request.path.slice(1).split("/").map(decodeURIComponent);
      } catch {
        return json(400, { type: "InvalidInput", message: "The path is malformed." });
      }
      const found = candidates(root, segments, 0, {});
      const match = found.find((candidate) => candidate.node.routes.has(request.method));
      if (match === undefined) {
        if (found.length === 0) {
          return { status: 404 };
        }
        const allowed = [...new Set(found.flatMap((candidate) => [...candidate.node.routes.keys()]))];
        return { status: 405, headers: { allow: allowed.join(", ") } };
      }
      const route = match.node.routes.get(request.method)!;
      try {
        return await respond(route, match.params, request);
      } catch (cause) {
        try {
          return failed(route, cause);
        } catch {
          return json(500, { type: "InternalError" });
        }
      }
    },
  });
}

/** Merges the selected route sets; overlapping routes fail startup with both names. */
export const restRouter = unit({
  requirements: { routes: declaredRestRoutes },
  factory: ({ routes }): RestRouter => {
    if (routes.length === 0) {
      throw new Error("Declare at least one restRoutes() in the selected modules.");
    }
    return createRouter(routes.flat());
  },
});
