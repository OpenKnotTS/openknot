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
import { collect, config, providePlugs, resource } from "@openknot-ts/wire";
import type {
  FastifyInstance,
  FastifyListenOptions,
  FastifyPluginCallback,
  FastifyRegister,
  RawServerBase,
} from "fastify";
import fastify from "fastify";
import { ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { z } from "zod";

/**
 * A native Fastify plugin: either a callback using `done` or an async function taking instance and options.
 * Fastify owns registration, execution and encapsulation.
 */
export type FastifyPlugin = FastifyPluginCallback;

/** The plugins the selected modules list join the host in module order; protocols bind here without importing it. */
export const fastifyPlugins = collect.contract<FastifyPlugin>();

export const fastifyHttpConfig = config({
  PORT: z
    .string()
    .regex(/^\d+$/, "must be an integer from 0 to 65535")
    .transform(Number)
    .pipe(z.int().min(0).max(65_535, "must be an integer from 0 to 65535"))
    .default(3000),
  HTTP_HOST: z.string().regex(/\S/, "must not be empty").default("127.0.0.1"),
});

type NativeFastify = Pick<FastifyInstance, "listen" | "close" | "listeningOrigin"> & {
  readonly server: RawServerBase;
  readonly register: FastifyRegister<unknown>;
};

export interface FastifyServer<Instance extends NativeFastify = FastifyInstance> {
  /** The native instance, for its routes, decorators, hooks and server. */
  readonly native: Instance;
  /** The native listening origin: HTTP/HTTPS address or Unix socket path. Available only while listening. */
  readonly url: string;
  readonly listening: boolean;
}

type Listen<R extends Requirements> = (dependencies: ResolvedReferences<R>) => FastifyListenOptions;
type ServerRequirements<R extends Requirements, Default extends boolean> = R & {
  readonly __plugins: typeof fastifyPlugins;
} & (Default extends true ? { readonly __listenConfig: typeof fastifyHttpConfig } : {});

export type FastifyHttpServer<
  Instance extends NativeFastify = FastifyInstance,
  R extends Requirements = {},
  Default extends boolean = true,
> = Provider<
  ManagedResource<FastifyServer<Instance>>,
  ResolvedReferences<ServerRequirements<R, Default>>,
  "resource",
  ServerRequirements<R, Default>
>;

async function listenFastify<Instance extends NativeFastify>(
  instance: Instance,
  plugins: readonly FastifyPlugin[],
  options: FastifyListenOptions,
  { signal }: CancellationOptions,
): Promise<ResourceHandle<FastifyServer<Instance>>> {
  let stopping = false;
  const pending = new Set<ServerResponse>();

  // A response admitted while the host stops closes its connection, so a keep-alive socket cannot hold the drain.
  const track = (_request: IncomingMessage | Http2ServerRequest, response: ServerResponse | Http2ServerResponse) => {
    // Connection: close is an HTTP/1 concern; HTTP/2 session shutdown belongs to Fastify.
    if (response instanceof ServerResponse) {
      pending.add(response);
      response.once("close", () => pending.delete(response));
      if (stopping) {
        response.shouldKeepAlive = false;
      }
    }
  };
  instance.server.on("request", track);

  const value: FastifyServer<Instance> = Object.freeze({
    native: instance,
    get url(): string {
      if (!instance.server.listening) {
        throw new Error("The server is stopped.");
      }
      return instance.listeningOrigin;
    },
    get listening(): boolean {
      return instance.server.listening;
    },
  });

  const listening = new AbortController();
  const cancel = () => listening.abort(signal.reason);

  signal.addEventListener("abort", cancel, { once: true });

  try {
    for (const plugin of plugins) {
      signal.throwIfAborted();
      await instance.register(plugin);
    }
    signal.throwIfAborted();
    const combined =
      options.signal === undefined ? listening.signal : AbortSignal.any([listening.signal, options.signal]);
    await instance.listen({ ...options, signal: combined });
    combined.throwIfAborted();
    listening.signal.throwIfAborted();
  } catch (error) {
    instance.server.off("request", track);
    await instance.close();
    throw listening.signal.aborted ? listening.signal.reason : error;
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
      }
      // Fastify answers new requests with 503 while closing and finishes the admitted ones before the server closes.
      await instance.close();
      instance.server.off("request", track);
    },
  };
}

/**
 * Owns a native instance created during acquisition. The application's own Fastify call preserves all native options
 * and inferred types. Omitting listen selects the default environment config; an explicit listen uses only the
 * declared configuration requirements.
 */
type HostOptions<R extends Requirements, Instance extends NativeFastify> = RequirementsOptions<R> & {
  readonly create: (dependencies: ResolvedReferences<R>) => Instance;
};

export function fastifyHttpServer<const R extends Requirements = {}, Instance extends NativeFastify = FastifyInstance>(
  options: HostOptions<R, Instance> & { readonly listen: Listen<R> },
): FastifyHttpServer<Instance, R, false>;

export function fastifyHttpServer<const R extends Requirements = {}, Instance extends NativeFastify = FastifyInstance>(
  options: HostOptions<R, Instance> & { readonly listen?: never },
): FastifyHttpServer<Instance, R>;

export function fastifyHttpServer<const R extends Requirements = {}, Instance extends NativeFastify = FastifyInstance>(
  options: HostOptions<R, Instance> & {
    readonly listen?: Listen<R>;
  },
): FastifyHttpServer<Instance, R, boolean> {
  const requirements = {
    ...(options.listen === undefined ? { __listenConfig: fastifyHttpConfig } : {}),
    ...options.requirements,
    __plugins: fastifyPlugins,
  } as ServerRequirements<R, boolean>;
  return resource({
    requirements,
    initialize: (dependencies, acquisition) => {
      const settings = (dependencies as { readonly __listenConfig: Resolved<typeof fastifyHttpConfig> }).__listenConfig;
      const listening =
        options.listen === undefined ? { port: settings.PORT, host: settings.HTTP_HOST } : options.listen(dependencies);
      const plugins = dependencies.__plugins as readonly FastifyPlugin[];
      return listenFastify(options.create(dependencies), plugins, listening, acquisition);
    },
  });
}

/** Ready-made host with Fastify's default options. */
export const fastifyServer = fastifyHttpServer({
  create: () => fastify(),
});
export const fastifyHttp = providePlugs([fastifyServer]);
