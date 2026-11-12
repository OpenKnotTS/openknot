import type { HttpHandler, HttpMiddleware } from "./handler.ts";
import { httpHandler, httpMiddleware } from "./handler.ts";
import type { ErrorReporter } from "@openknot-ts/error-reporting";
import { reportError } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import type { Logger } from "@openknot-ts/logging";
import { logger } from "@openknot-ts/logging/wire";
import type {
  CancellationOptions,
  ManagedResource,
  Provider,
  Requirements,
  RequirementsOptions,
  Resolved,
  ResolvedReferences,
  ResourceHandle,
} from "@openknot-ts/wire";
import type { OptionalDependency } from "@openknot-ts/wire";
import { config, optional, providePlugs, resource } from "@openknot-ts/wire";
import type { Serve, Server, ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";

export { httpHandler, httpMiddleware } from "./handler.ts";
export type { HttpHandler, HttpMiddleware } from "./handler.ts";

function integer(maximum = Number.MAX_SAFE_INTEGER) {
  const error = `must be an integer from 0 to ${maximum}`;
  return z
    .string()
    .regex(/^\d+$/, error)
    .transform(Number)
    .pipe(z.int({ error }).min(0, { error }).max(maximum, { error }));
}

/** Explicit environment values override native options; unset tuning keeps Bun's defaults. */
export const httpConfig = config({
  PORT: integer(65_535).optional(),
  HTTP_HOST: z.string().regex(/\S/, "must not be empty").optional(),
  HTTP_IDLE_TIMEOUT_SECONDS: integer(255).optional(),
  HTTP_MAX_REQUEST_BODY_SIZE: integer().optional(),
});

export interface HttpServer<Data = undefined> {
  /** The native server, for its native events, tuning and WebSocket publishing. */
  readonly native: Server<Data>;
  /** The native bound URL, including the chosen port when port=0; available while listening. */
  readonly url: string;
  readonly listening: boolean;
}

// Each branch retains Bun's TCP/Unix and WebSocket/route option constraints.
type WithoutFetch<O> = O extends unknown ? Omit<O, "fetch"> & { readonly fetch?: never } : never;
export type BunHttpOptions<Data = undefined, Route extends string = string> = WithoutFetch<Serve.Options<Data, Route>>;

type HandlerReference = Provider<HttpHandler<any>, never, "unit">;
type HandlerData<H extends HandlerReference> = Resolved<H> extends HttpHandler<infer Data> ? Data : never;

export type BunHttpServerReferences<H extends HandlerReference = Provider<HttpHandler, never, "unit">> = {
  readonly handler: H;
};

type ServerRequirements<H extends HandlerReference, R extends Requirements, Default extends boolean> = R &
  BunHttpServerReferences<H> & {
    readonly middleware: typeof httpMiddleware;
    readonly __reporter: OptionalDependency<typeof errorReporter>;
    readonly __logger: typeof logger;
  } & (Default extends true ? { readonly __httpConfig: typeof httpConfig } : {});

export type BunHttpServer<
  H extends HandlerReference = Provider<HttpHandler, never, "unit">,
  R extends Requirements = {},
  Default extends boolean = true,
> = Provider<
  ManagedResource<HttpServer<HandlerData<H>>>,
  ResolvedReferences<ServerRequirements<H, R, Default>>,
  "resource",
  ServerRequirements<H, R, Default>
>;

async function listenBunHttpServer<Data, Route extends string>(
  handler: HttpHandler<Data>,
  settings: Resolved<typeof httpConfig> | undefined,
  options: BunHttpOptions<Data, Route>,
  middleware: readonly HttpMiddleware[],
  reporter: ErrorReporter | undefined,
  log: Logger,
  { signal }: CancellationOptions,
): Promise<ResourceHandle<HttpServer<Data>>> {
  if (options.unix !== undefined && (settings?.PORT !== undefined || settings?.HTTP_HOST !== undefined)) {
    throw new TypeError("A Unix HTTP server cannot also configure PORT or HTTP_HOST.");
  }

  const dispatch = middleware.reduceRight<HttpHandler<Data>>(
    (next, current) =>
      function (request, server) {
        return current.call(server, request, server, () => next.call(server, request, server));
      },
    handler,
  );

  signal.throwIfAborted();

  let listening = true;
  let stopping = false;

  // A WebSocket never ends by itself: the host tracks the open ones to close them as it stops.
  const sockets = new Set<ServerWebSocket<Data>>();
  const nativeWebSocket = (options as { readonly websocket?: WebSocketHandler<Data> }).websocket;
  const websocket: WebSocketHandler<Data> | undefined =
    nativeWebSocket === undefined
      ? undefined
      : {
          ...nativeWebSocket,
          open(socket) {
            sockets.add(socket);
            return nativeWebSocket.open?.call(this, socket);
          },
          close(socket, code, reason) {
            sockets.delete(socket);
            return nativeWebSocket.close?.call(this, socket, code, reason);
          },
        };

  const native = Bun.serve<Data, Route>({
    development: false,
    // Answers a failure the host has already logged and reported, as Node's rejection capture does; a native error
    // handler replaces it.
    error: () => new Response("Internal Server Error", { status: 500 }),
    ...options,
    ...(settings !== undefined && options.unix === undefined
      ? {
          port: settings.PORT ?? options.port ?? 3000,
          hostname: settings.HTTP_HOST ?? options.hostname ?? "127.0.0.1",
        }
      : {}),
    ...(settings?.HTTP_IDLE_TIMEOUT_SECONDS === undefined ? {} : { idleTimeout: settings.HTTP_IDLE_TIMEOUT_SECONDS }),
    ...(settings?.HTTP_MAX_REQUEST_BODY_SIZE === undefined
      ? {}
      : { maxRequestBodySize: settings.HTTP_MAX_REQUEST_BODY_SIZE }),
    ...(websocket === undefined ? {} : { websocket }),
    fetch(request, server) {
      if (stopping) {
        return new Response("Service Unavailable", { status: 503 });
      }

      // A failing handler is logged and reported, then answered by the server's error handler.
      const reported = (error: unknown): never => {
        log.error("HTTP request handler failed", { error });
        reportError(reporter, { error, source: "openknot.http", expected: false });
        throw error;
      };
      try {
        const response = dispatch.call(server, request, server);
        return response instanceof Promise ? response.catch(reported) : response;
      } catch (error) {
        return reported(error);
      }
    },
    // fetch is supplied by DI independently of the native WebSocket/route option union.
  } as Serve.Options<Data, Route>);

  return {
    value: Object.freeze({
      native,
      get url() {
        if (!listening) {
          throw new Error("The server is stopped.");
        }

        return native.url.href;
      },
      get listening() {
        return listening;
      },
    }),
    async release() {
      stopping = true;
      listening = false;
      // Native stop closes intake and idle sockets and drains in-flight responses; it waits for open WebSockets, which
      // close with 1001 (going away) so that their clients reconnect elsewhere.
      const stopped = native.stop();
      for (const socket of sockets) {
        socket.close(1001, "Server shutting down");
      }
      await stopped;
    },
  };
}

export function bunHttpServer<
  const H extends HandlerReference,
  const R extends Requirements = {},
  Route extends string = never,
>(
  declaration: BunHttpServerReferences<H> &
    RequirementsOptions<R> & {
      readonly options: (dependencies: ResolvedReferences<R>) => BunHttpOptions<NoInfer<HandlerData<H>>, Route>;
    },
): BunHttpServer<H, R, false>;

export function bunHttpServer<
  const H extends HandlerReference,
  const R extends Requirements = {},
  Route extends string = never,
>(
  declaration: BunHttpServerReferences<H> &
    RequirementsOptions<R> & {
      readonly options?: BunHttpOptions<NoInfer<HandlerData<H>>, Route>;
    },
): BunHttpServer<H, R>;

/**
 * Native options are snapshotted and retain default environment tuning. An options callback selects only its own
 * configuration requirements, without implicitly loading the default environment config.
 */
export function bunHttpServer<
  const H extends HandlerReference,
  const R extends Requirements = {},
  Route extends string = never,
>({
  handler,
  requirements: declared,
  options = {},
}: BunHttpServerReferences<H> &
  RequirementsOptions<R> & {
    readonly options?:
      | BunHttpOptions<NoInfer<HandlerData<H>>, Route>
      | ((dependencies: ResolvedReferences<R>) => BunHttpOptions<NoInfer<HandlerData<H>>, Route>);
  }): BunHttpServer<H, R, boolean> {
  const nativeOptions = typeof options === "function" ? options : { ...options };
  const requirements = {
    ...(typeof options === "function" ? {} : { __httpConfig: httpConfig }),
    ...declared,
    handler,
    middleware: httpMiddleware,
    __reporter: optional(errorReporter),
    __logger: logger,
  } as ServerRequirements<H, R, boolean>;
  return resource({
    requirements,
    initialize: (dependencies, acquisition) => {
      const values = dependencies as ResolvedReferences<R> & {
        readonly handler: HttpHandler<HandlerData<H>>;
        readonly middleware: readonly HttpMiddleware[];
        readonly __reporter: ErrorReporter | undefined;
        readonly __logger: Logger;
        readonly __httpConfig: Resolved<typeof httpConfig>;
      };
      const settings = typeof nativeOptions === "function" ? undefined : values.__httpConfig;
      const selected = typeof nativeOptions === "function" ? nativeOptions(values) : nativeOptions;
      return listenBunHttpServer(
        values.handler,
        settings,
        selected,
        values.middleware,
        values.__reporter,
        values.__logger,
        acquisition,
      );
    },
  });
}

export const httpServer = bunHttpServer({ handler: httpHandler });
export const http = providePlugs([httpServer]);
