import { httpHandler } from "@openknot-ts/knot-http-node/handler";
import { trpcContextFactory } from "@openknot-ts/trpc-context/wire";
import type { trpc } from "@openknot-ts/trpc-router";
import { trpcRootRouter } from "@openknot-ts/trpc-router";
import type { Provider, Resolved, ResolvedReferences, Requirements, RequirementsOptions } from "@openknot-ts/wire";
import { config, providePlugs, unit } from "@openknot-ts/wire";
import type { AnyTRPCRouter, inferRouterContext, TRPCBuiltRouter, TRPCRouterRecord } from "@trpc/server";
import { createURL } from "@trpc/server/adapters/node-http";
import type { CreateHTTPHandlerOptions } from "@trpc/server/adapters/standalone";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import type { RequestListener, Server } from "node:http";
import { z } from "zod";

/** An explicit environment limit overrides native options; unset preserves tRPC's default. */
export const trpcHttpConfig = config({
  TRPC_BASE_PATH: z
    .string()
    .startsWith("/", "must start with /")
    .transform((value) => (value.endsWith("/") ? value : `${value}/`))
    .optional(),
  TRPC_MAX_BODY_SIZE: z
    .union(
      [z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(0)), z.literal("Infinity").transform(Number)],
      { error: "must be a non-negative integer or Infinity" },
    )
    .optional(),
});

function configuredOptions(
  settings: Resolved<typeof trpcHttpConfig>,
  options: { basePath?: string; maxBodySize?: number },
) {
  const basePath = settings.TRPC_BASE_PATH ?? options.basePath;
  const maxBodySize = settings.TRPC_MAX_BODY_SIZE ?? options.maxBodySize;

  return { ...(basePath === undefined ? {} : { basePath }), ...(maxBodySize === undefined ? {} : { maxBodySize }) };
}

/** The standalone adapter slices the prefix; mounting owns validation of the actual pathname. */
function mountedHandler<R extends AnyTRPCRouter>(options: CreateHTTPHandlerOptions<R>): RequestListener {
  const handler = createHTTPHandler(options);
  const basePath = options.basePath ?? "/";

  if (basePath === "/") {
    return handler;
  }

  return function (this: Server, request, response) {
    let pathname: string;
    try {
      pathname = createURL(request).pathname;
    } catch {
      // Retain native tRPC error formatting and onError for malformed URLs.
      return handler.call(this, request, response);
    }

    if (!pathname.startsWith(basePath)) {
      response.writeHead(404).end();
      return;
    }

    return handler.call(this, request, response);
  };
}

type RouterReference = Provider<AnyTRPCRouter, never, "unit">;
type ContextReference<R extends RouterReference> = Provider<
  NonNullable<CreateHTTPHandlerOptions<Resolved<R>>["createContext"]>,
  never,
  "unit"
>;

type NativeOptions<R extends RouterReference> = Omit<CreateHTTPHandlerOptions<Resolved<R>>, "router" | "createContext">;
type HandlerRequirements<
  R extends RouterReference,
  C extends ContextReference<R> | undefined,
  Extra extends Requirements = {},
> = Extra & {
  readonly router: R;
} & (C extends ContextReference<R> ? { readonly createContext: C } : {});

/** The handler's own requirement names stay reserved, so an application requirement cannot replace them. */
type ExtraRequirements = Requirements & { readonly router?: never; readonly createContext?: never };

/** A native handler unit that carries its exact router/context requirements through the graph. */
export type TrpcHandler<
  R extends RouterReference,
  C extends ContextReference<R> | undefined = undefined,
  Extra extends Requirements = {},
> = Provider<
  RequestListener,
  ResolvedReferences<HandlerRequirements<R, C, Extra>>,
  "unit",
  HandlerRequirements<R, C, Extra>
>;

export function trpcHandler<
  const R extends RouterReference,
  const C extends ContextReference<NoInfer<R>>,
  const Extra extends ExtraRequirements,
>(options: {
  readonly router: R;
  readonly createContext: C;
  readonly requirements: Extra;
  readonly options: (dependencies: ResolvedReferences<Extra>) => NativeOptions<NoInfer<R>>;
}): TrpcHandler<R, C, Extra>;

export function trpcHandler<const R extends RouterReference, const Extra extends ExtraRequirements>(
  options: {
    readonly router: R;
    readonly requirements: Extra;
    readonly options: (dependencies: ResolvedReferences<Extra>) => NativeOptions<NoInfer<R>>;
  } & (object extends inferRouterContext<Resolved<R>>
    ? { readonly createContext?: never }
    : { readonly createContext: never }),
): TrpcHandler<R, undefined, Extra>;

export function trpcHandler<const R extends RouterReference, const C extends ContextReference<NoInfer<R>>>(
  options: NativeOptions<NoInfer<R>> & { readonly router: R; readonly createContext: C },
): TrpcHandler<R, C>;

export function trpcHandler<const R extends RouterReference>(
  options: NativeOptions<NoInfer<R>> & { readonly router: R } & (object extends inferRouterContext<Resolved<R>>
      ? { readonly createContext?: never }
      : { readonly createContext: never }),
): TrpcHandler<R>;

/** Resolves references once and forwards the complete native options to tRPC's HTTP adapter. */
export function trpcHandler({
  router,
  createContext,
  requirements,
  options: select,
  ...options
}: NativeOptions<RouterReference> & {
  readonly router: RouterReference;
  readonly createContext?: ContextReference<RouterReference>;
  readonly requirements?: Requirements;
  readonly options?: (dependencies: ResolvedReferences<Requirements>) => NativeOptions<RouterReference>;
}) {
  return unit({
    requirements: {
      ...requirements,
      router,
      ...(select === undefined ? { __config: trpcHttpConfig } : {}),
      ...(createContext === undefined ? {} : { createContext }),
    },
    factory: (dependencies) =>
      mountedHandler({
        ...(select === undefined ? options : select(dependencies)),
        router: dependencies.router,
        ...(createContext === undefined ? {} : { createContext: dependencies.createContext }),
        ...(select === undefined
          ? configuredOptions(dependencies.__config as Resolved<typeof trpcHttpConfig>, options)
          : {}),
      }),
  });
}

type DefaultRouter = Pick<
  TRPCBuiltRouter<Resolved<typeof trpc>["_config"]["$types"], TRPCRouterRecord>,
  "_def" | "createCaller"
>;

export type TrpcHttpOptions = Omit<CreateHTTPHandlerOptions<DefaultRouter>, "router" | "createContext">;

/** All native HTTP options remain available; environment settings take precedence. */
export const trpcHttpOptions = unit({ factory: (): TrpcHttpOptions => ({ basePath: "/trpc/" }) });

type Declaration<R extends Requirements> = RequirementsOptions<R> & {
  readonly options?: (dependencies: ResolvedReferences<R>) => TrpcHttpOptions;
};

/** Implements only the HTTP handler contract; no server implementation is imported or constructed here. */
export function nodeTrpcHandler<const R extends Requirements = {}>(declaration: Declaration<R> = {} as Declaration<R>) {
  return unit({
    // Prefixed, so the application's own requirements keep their names; a callback replaces the default options.
    requirements: {
      ...declaration.requirements,
      __router: trpcRootRouter,
      __createContext: trpcContextFactory,
      ...(declaration.options === undefined ? { __options: trpcHttpOptions, __settings: trpcHttpConfig } : {}),
    },
    factory: (dependencies): RequestListener => {
      const {
        __router: router,
        __createContext: createContext,
        __options: options,
        __settings: settings,
      } = dependencies;
      return mountedHandler({
        ...(declaration.options === undefined
          ? (options as TrpcHttpOptions)
          : declaration.options(dependencies as ResolvedReferences<R>)),
        router,
        createContext,
        ...(declaration.options === undefined
          ? configuredOptions(settings as Resolved<typeof trpcHttpConfig>, options as TrpcHttpOptions)
          : {}),
      });
    },
  });
}
export const trpcHttpHandler = unit({
  provides: httpHandler,
  requirements: { handler: nodeTrpcHandler() },
  factory: ({ handler }) => handler,
});

/**
 * Opt-in protocol implementation. The selected Node HTTP host consumes its binding through DI; the router and
 * context the handler requires join through its requirements.
 */
export const trpcHttp = providePlugs([trpcHttpHandler]);
