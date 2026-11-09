import type {
  ActorResolver,
  BroadcastDefinition,
  ExecutionActor,
  ExposureDefinition,
  ExposureInvoker,
  ResolvedBroadcast,
  ResolvedTopic,
  TopicDefinition,
} from "@openknot-ts/flow";
import {
  ActorAuthenticationError,
  InputCancelledError,
  InputUnavailableError,
  isBroadcast,
  isExposure,
  isTopic,
} from "@openknot-ts/flow";
import type { PropagationCarrier, Tracing } from "@openknot-ts/tracing";
import { propagationFields } from "@openknot-ts/tracing";
import { TRPCError } from "@trpc/server";

export interface TrpcContext {
  readonly actor: ExecutionActor | undefined;
  readonly signal: AbortSignal;
  readonly propagation: PropagationCarrier;
}

/** Credentials remain in the request closure and never enter a Flow request. */
export interface TrpcAuthenticationContext extends TrpcContext {
  readonly authenticate: <Actor>(resolve: ActorResolver<Actor>) => Promise<Actor | undefined>;
}

export interface TrpcContextOptions {
  readonly tracing?: Tracing | undefined;
}

/** The shared request fields supplied by native Node HTTP, Fastify and Express adapters. */
export interface TrpcContextInput {
  readonly req: {
    readonly headers: {
      readonly authorization?: string | undefined;
      readonly [name: string]: string | string[] | undefined;
    };
  };
  readonly info: {
    readonly signal: AbortSignal;
    readonly connectionParams?: Readonly<Record<string, string | undefined>> | null | undefined;
    /** The request URL; tRPC's WebSocket adapter supplies `null`, its HTTP adapters a URL. */
    readonly url?: URL | null | undefined;
  };
}

export type TrpcContextFactory = (options: TrpcContextInput) => Promise<TrpcAuthenticationContext>;

/** Native tRPC context; no raw credentials are exposed to application guards/handlers. */
export function createTrpcContext(options: TrpcContextOptions = {}): TrpcContextFactory {
  const { tracing } = options;

  return async ({ req, info }) => {
    const signal = info.signal;
    signal.throwIfAborted();
    const authorization = req.headers.authorization;
    // Only tRPC's WebSocket adapter consumes connection parameters. Its HTTP adapters also read them from the URL's
    // query, so a client-sent `upgrade` header must not let an HTTP or SSE request authenticate with a URL token.
    const connectionToken = info.url === null ? info.connectionParams?.token : undefined;

    const authenticate = async <Actor>(resolve: ActorResolver<Actor>): Promise<Actor | undefined> => {
      signal.throwIfAborted();
      const token = authorization === undefined ? connectionToken : /^Bearer[ \t]+(\S+)$/i.exec(authorization)?.[1];

      if (authorization === undefined && connectionToken === undefined) {
        return undefined;
      }
      if (token === undefined || !/^\S+$/.test(token)) {
        throw ActorAuthenticationError();
      }

      const actor = await resolve(token, { signal });
      signal.throwIfAborted();
      return actor;
    };

    const propagation = Object.freeze(
      Object.fromEntries(
        propagationFields(tracing).flatMap((name) => {
          const value = req.headers[name.toLowerCase()];
          return value === undefined ? [] : [[name, Array.isArray(value) ? value.join(",") : value]];
        }),
      ),
    );

    return Object.freeze({ actor: undefined, signal, propagation, authenticate });
  };
}

export { actorAuthentication, authenticationErrorFormatter } from "./authentication.ts";
export type {
  ActorAuthenticationMiddleware,
  AuthenticationErrorShape,
  AuthenticationFailure,
} from "./authentication.ts";

/** The execution fields a Flow input receives from the tRPC context; nothing else in it is forwarded. */
type ExecutionField = "signal" | "actor" | "propagation";

/** What a procedure supplies besides those fields: the input and named guard inputs, none of them when void. */
export type FlowRequest<R> = Omit<R, ExecutionField>;

/** Flow's own failures with a transport meaning; any other error reaches tRPC unchanged. */
function procedureError(error: unknown): unknown {
  if (InputCancelledError.is(error)) {
    return new TRPCError({ code: "CLIENT_CLOSED_REQUEST", cause: error });
  }

  if (InputUnavailableError.is(error)) {
    return new TRPCError({ code: "SERVICE_UNAVAILABLE", cause: error });
  }
  return error;
}

/**
 * Calls a Flow input, such as an exposure or a subscription's admission, from a tRPC procedure: it forwards the
 * context's signal, actor and trace propagation and returns the input's value. A cancelled or unavailable input
 * rejects with its tRPC code; any other failure reaches tRPC unchanged, so mapping authored errors stays with the
 * application.
 */
export async function invokeFlow<R extends object, V>(
  ctx: Pick<TrpcContext, ExecutionField>,
  invoke: (request: R) => Promise<V>,
  ...[request]: {} extends FlowRequest<R> ? [request?: FlowRequest<R>] : [request: FlowRequest<R>]
): Promise<V> {
  const { signal, actor, propagation } = ctx;

  // The request type is the invoker's own; its execution fields come from the context.
  return call(invoke, { ...request, signal, actor, propagation } as R);
}

async function call<R, V>(invoke: (request: R) => Promise<V>, request: R): Promise<V> {
  try {
    return await invoke(request);
  } catch (error) {
    throw procedureError(error);
  }
}

/** What a resolver's options carry for a Flow input, besides the input and named guard inputs. */
export interface FlowResolverOptions {
  readonly ctx: Pick<TrpcContext, ExecutionField>;
}

/** A subscription also reads the resolver's own signal, which ends with it. */
export interface FlowSubscriptionOptions extends FlowResolverOptions {
  readonly signal?: AbortSignal | undefined;
}

/** A Flow input as a native tRPC resolver, as in `.mutation(createRole)`. */
export type FlowResolver<I, O = FlowResolverOptions> = I extends (request: infer R extends object) => Promise<infer V>
  ? (options: O & FlowRequest<R>) => Promise<V>
  : never;

type FlowSubscription<P extends { readonly subscribe: unknown }> = Omit<P, "subscribe"> & {
  readonly subscribe: FlowResolver<P["subscribe"], FlowSubscriptionOptions>;
};

/** What a Flow reference resolves to inside a router's routes; never for any other reference. */
export type FlowInput<D> = D extends ExposureDefinition
  ? FlowResolver<ExposureInvoker<D>>
  : D extends TopicDefinition
    ? FlowSubscription<ResolvedTopic<D>>
    : D extends BroadcastDefinition
      ? FlowSubscription<ResolvedBroadcast<D>>
      : never;

/** Options tRPC passes a resolver: a guard named after one would silently receive tRPC's value. */
const resolverOptions: ReadonlySet<string> = new Set(["ctx", "path", "batchIndex"]);

type Invoker = (request: object) => Promise<unknown>;

function flowResolver<O extends FlowResolverOptions>(
  invoke: Invoker,
  guards: object,
  signalOf: (options: O) => AbortSignal,
): (options: O) => Promise<unknown> {
  const names = Object.keys(guards);

  for (const name of names) {
    if (resolverOptions.has(name)) {
      throw new TypeError(`Guard name '${name}' collides with a tRPC resolver option`);
    }
  }

  return (options) => {
    const { ctx } = options;
    const fields = options as unknown as Readonly<Record<string, unknown>>;
    const request: Record<string, unknown> = {
      input: fields.input,
      traceAttributes: fields.traceAttributes,
      signal: signalOf(options),
      actor: ctx.actor,
      propagation: ctx.propagation,
    };

    for (const name of names) {
      request[name] = fields[name];
    }

    return call(invoke, request);
  };
}

/** Gives a resolved exposure, topic or broadcast its form inside a router's routes; anything else stays as it is. */
export function flowInput(reference: object, value: unknown): unknown {
  if (isExposure(reference)) {
    // Over a WebSocket, a query or mutation's own signal never aborts; the context's follows its connection.
    return flowResolver(value as Invoker, reference.guards, ({ ctx }: FlowResolverOptions) => ctx.signal);
  }

  if (isTopic(reference) || isBroadcast(reference)) {
    const port = value as { readonly subscribe: Invoker };
    // A subscription's own signal ends with it, with its connection and with its request.
    const signalOf = ({ ctx, signal }: FlowSubscriptionOptions) => signal ?? ctx.signal;
    return Object.freeze({ ...port, subscribe: flowResolver(port.subscribe, reference.guards, signalOf) });
  }

  return value;
}
