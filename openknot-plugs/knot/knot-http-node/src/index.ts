import type { HttpMiddleware } from "./handler.ts";
import { httpHandler, httpMiddleware } from "./handler.ts";
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
import { config, providePlugs, resource } from "@openknot-ts/wire";
import { captureRejectionSymbol, once } from "node:events";
import type { RequestListener, Server, ServerOptions, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { ListenOptions } from "node:net";
import { z } from "zod";

export { httpHandler, httpMiddleware } from "./handler.ts";
export type { HttpMiddleware } from "./handler.ts";

function integer(maximum = Number.MAX_SAFE_INTEGER) {
  const error = `must be an integer from 0 to ${maximum}`;
  return z
    .string()
    .regex(/^\d+$/, error)
    .transform(Number)
    .pipe(z.int({ error }).min(0, { error }).max(maximum, { error }));
}

const optionalInteger = integer().optional();

/** Unset tuning variables preserve the supplied native options, then Node's defaults. */
export const httpConfig = config({
  PORT: integer(65_535).default(3000),
  HTTP_HOST: z.string().regex(/\S/, "must not be empty").default("127.0.0.1"),
  HTTP_REQUEST_TIMEOUT_MS: optionalInteger,
  HTTP_HEADERS_TIMEOUT_MS: optionalInteger,
  HTTP_KEEP_ALIVE_TIMEOUT_MS: optionalInteger,
  HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS: optionalInteger,
  HTTP_SOCKET_TIMEOUT_MS: optionalInteger,
  HTTP_MAX_HEADER_SIZE: optionalInteger,
  HTTP_MAX_HEADERS_COUNT: optionalInteger,
  HTTP_MAX_REQUESTS_PER_SOCKET: optionalInteger,
});

export interface HttpServer {
  /** The unwrapped Node server, for native events, tuning and WebSocket adapters. */
  readonly native: Server;
  /** The bound address, with the actual port when PORT=0. Available only while listening. */
  readonly url: string;
  readonly listening: boolean;
}

export type NodeHttpServerReferences<
  H extends Provider<RequestListener, never, "unit"> = Provider<RequestListener, never, "unit">,
> = {
  readonly handler: H;
};

type Listen<R extends Requirements> = (dependencies: ResolvedReferences<R>) => ListenOptions;

type ServerRequirements<
  H extends Provider<RequestListener, never, "unit">,
  R extends Requirements,
  Default extends boolean,
> = R & {
  readonly handler: H;
  readonly middleware: typeof httpMiddleware;
} & (Default extends true ? { readonly __httpConfig: typeof httpConfig } : {});

export type NodeHttpServer<
  H extends Provider<RequestListener, never, "unit"> = Provider<RequestListener, never, "unit">,
  R extends Requirements = {},
  Default extends boolean = true,
> = Provider<
  ManagedResource<HttpServer>,
  ResolvedReferences<ServerRequirements<H, R, Default>>,
  "resource",
  ServerRequirements<H, R, Default>
>;

async function listenNodeHttpServer(
  handler: RequestListener,
  settings: Resolved<typeof httpConfig> | undefined,
  options: ServerOptions,
  address: ListenOptions,
  middleware: readonly HttpMiddleware[],
  { signal }: CancellationOptions,
): Promise<ResourceHandle<HttpServer>> {
  const dispatch = middleware.reduceRight<RequestListener>(
    (next, current) => (request, response) =>
      current.call(server, request, response, () => next.call(server, request, response)),
    handler,
  );
  let stopping = false;
  const pending = new Set<ServerResponse>();

  const server = createServer(
    {
      ...options,
      requestTimeout: settings?.HTTP_REQUEST_TIMEOUT_MS ?? options.requestTimeout,
      headersTimeout: settings?.HTTP_HEADERS_TIMEOUT_MS ?? options.headersTimeout,
      keepAliveTimeout: settings?.HTTP_KEEP_ALIVE_TIMEOUT_MS ?? options.keepAliveTimeout,
      keepAliveTimeoutBuffer: settings?.HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS ?? options.keepAliveTimeoutBuffer,
      maxHeaderSize: settings?.HTTP_MAX_HEADER_SIZE ?? options.maxHeaderSize,
    },
    (request, response) => {
      // A new request on an existing connection must not enter the application during draining.
      if (stopping) {
        response.writeHead(503, { connection: "close" }).end();
        return;
      }
      pending.add(response);
      response.once("close", () => pending.delete(response));

      // Answers as Node's own rejection capture does, which an application would otherwise have to enable process-wide.
      const failed = (error: unknown) => {
        console.error(error);
        server[captureRejectionSymbol]?.(error as Error, "request", request, response);
      };

      try {
        void Promise.resolve<unknown>(dispatch.call(server, request, response)).catch(failed);
      } catch (error) {
        failed(error);
      }
    },
  );

  if (settings?.HTTP_SOCKET_TIMEOUT_MS !== undefined) {
    server.setTimeout(settings.HTTP_SOCKET_TIMEOUT_MS);
  }

  if (settings?.HTTP_MAX_HEADERS_COUNT !== undefined) {
    server.maxHeadersCount = settings.HTTP_MAX_HEADERS_COUNT;
  }

  if (settings?.HTTP_MAX_REQUESTS_PER_SOCKET !== undefined) {
    server.maxRequestsPerSocket = settings.HTTP_MAX_REQUESTS_PER_SOCKET;
  }

  const value: HttpServer = Object.freeze({
    native: server,
    get url(): string {
      const address = server.address();
      if (address === null) {
        throw new Error("The server is stopped.");
      }
      if (typeof address === "string") {
        return address;
      }
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return `http://${host}:${address.port}`;
    },
    get listening(): boolean {
      return server.listening;
    },
  });

  const listening = new AbortController();
  const cancel = () => listening.abort(signal.reason);
  const combined =
    address.signal === undefined ? listening.signal : AbortSignal.any([listening.signal, address.signal]);

  signal.addEventListener("abort", cancel, { once: true });

  try {
    signal.throwIfAborted();
    server.listen({ ...address, signal: combined });
    await once(server, "listening", { signal: combined });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw combined.aborted ? combined.reason : error;
  } finally {
    // Startup cancellation must not close a running host outside its graceful shutdown phase.
    signal.removeEventListener("abort", cancel);
  }

  return {
    value,
    async release(): Promise<void> {
      stopping = true;
      for (const response of pending) {
        response.shouldKeepAlive = false;
        if (!response.headersSent) {
          response.setHeader("connection", "close");
        }
      }
      // Native listen signals can already have closed the server; close() still emits its close event.
      const closed = once(server, "close");
      server.close();
      // Admitted responses finish first. A connection without one, such as one still sending its headers, has nothing to
      // drain; closing all connections leaves sockets upgraded to another protocol to their adapter.
      await Promise.all([...pending].map((response) => once(response, "close")));
      server.closeAllConnections();
      await closed;
    },
  };
}

/**
 * A native host: it listens once acquired, and release stops intake and drains admitted requests. Native
 * constructor options remain available. Omitting listen selects the default environment config; an explicit listen
 * uses only the declared requirements. Selected native middleware runs before the application's handler.
 */
type HostOptions<
  H extends Provider<RequestListener, never, "unit">,
  R extends Requirements,
> = NodeHttpServerReferences<H> &
  RequirementsOptions<R> & {
    readonly options?: ServerOptions | ((dependencies: ResolvedReferences<R>) => ServerOptions);
  };

export function nodeHttpServer<
  const H extends Provider<RequestListener, never, "unit">,
  const R extends Requirements = {},
>(declaration: HostOptions<H, R> & { readonly listen: Listen<R> }): NodeHttpServer<H, R, false>;

export function nodeHttpServer<
  const H extends Provider<RequestListener, never, "unit">,
  const R extends Requirements = {},
>(declaration: HostOptions<H, R> & { readonly listen?: never }): NodeHttpServer<H, R>;

export function nodeHttpServer<
  const H extends Provider<RequestListener, never, "unit">,
  const R extends Requirements = {},
>({
  handler,
  requirements: declared,
  listen,
  options = {},
}: HostOptions<H, R> & {
  readonly listen?: Listen<R>;
}): NodeHttpServer<H, R, boolean> {
  const nativeOptions = typeof options === "function" ? options : { ...options };
  const requirements = {
    ...(listen === undefined ? { __httpConfig: httpConfig } : {}),
    ...declared,
    handler,
    middleware: httpMiddleware,
  } as ServerRequirements<H, R, boolean>;
  return resource({
    requirements,
    initialize: (dependencies, acquisition) => {
      const values = dependencies as ResolvedReferences<R> & {
        readonly handler: RequestListener;
        readonly middleware: readonly HttpMiddleware[];
        readonly __httpConfig: Resolved<typeof httpConfig>;
      };
      const settings = listen === undefined ? values.__httpConfig : undefined;
      const address =
        listen === undefined ? { port: values.__httpConfig.PORT, host: values.__httpConfig.HTTP_HOST } : listen(values);
      const selectedOptions = typeof nativeOptions === "function" ? nativeOptions(values) : nativeOptions;
      return listenNodeHttpServer(values.handler, settings, selectedOptions, address, values.middleware, acquisition);
    },
  });
}

/** Ready-made host; its handler is selected by the application's ordinary DI bindings. */
export const httpServer = nodeHttpServer({ handler: httpHandler });
export const http = providePlugs([httpServer]);
