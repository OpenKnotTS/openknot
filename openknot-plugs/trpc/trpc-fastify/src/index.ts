import type { FastifyPlugin } from "@openknot-ts/fastify-server";
import { fastifyPlugins } from "@openknot-ts/fastify-server";
import { trpcContextFactory } from "@openknot-ts/trpc-context/wire";
import { trpcRootRouter } from "@openknot-ts/trpc-router";
import type { Resolved, Requirements, RequirementsOptions, ResolvedReferences } from "@openknot-ts/wire";
import { config, providePlugs, unit } from "@openknot-ts/wire";
import type { FastifyTRPCPluginOptions } from "@trpc/server/adapters/fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { z } from "zod";

/** An explicit environment value overrides the native prefix. */
export const trpcFastifyConfig = config({
  TRPC_BASE_PATH: z
    .string()
    .startsWith("/", "must start with /")
    .transform((value) => value.replace(/\/+$/, "") || "/")
    .optional(),
});

type RootRouter = Resolved<typeof trpcRootRouter>;
type PluginOptions = FastifyTRPCPluginOptions<RootRouter>;

/** Native plugin options apart from the router and context, which the selected routers and context factory supply. */
export type TrpcFastifyOptions = Omit<PluginOptions, "trpcOptions"> & {
  readonly trpcOptions?: Omit<PluginOptions["trpcOptions"], "router" | "createContext">;
};

/** All native options remain available; the environment's base path takes precedence. */
export const trpcFastifyOptions = unit({ factory: (): TrpcFastifyOptions => ({ prefix: "/trpc" }) });

type Declaration<R extends Requirements> = RequirementsOptions<R> & {
  readonly options?: (dependencies: ResolvedReferences<R>) => TrpcFastifyOptions;
};

/** Registers tRPC's official Fastify plugin over the merged routers the selected modules list. */
export function fastifyTrpcPlugin<const R extends Requirements = {}>(
  declaration: Declaration<R> = {} as Declaration<R>,
) {
  return unit({
    provides: fastifyPlugins,
    // Prefixed, so the application's own requirements keep their names; a callback replaces the default options.
    requirements: {
      ...declaration.requirements,
      __router: trpcRootRouter,
      __createContext: trpcContextFactory,
      ...(declaration.options === undefined ? { __options: trpcFastifyOptions, __settings: trpcFastifyConfig } : {}),
    },
    factory:
      (dependencies): FastifyPlugin =>
      async (instance) => {
        const {
          __router: router,
          __createContext: createContext,
          __options: defaults,
          __settings: settings,
        } = dependencies;
        const options =
          declaration.options === undefined
            ? (defaults as TrpcFastifyOptions)
            : declaration.options(dependencies as ResolvedReferences<R>);
        const prefix =
          declaration.options === undefined ? (settings?.TRPC_BASE_PATH ?? options.prefix) : options.prefix;
        await instance.register(fastifyTRPCPlugin, {
          ...options,
          ...(prefix === undefined ? {} : { prefix }),
          trpcOptions: { ...options.trpcOptions, router, createContext },
        });
      },
  });
}
export const trpcFastifyPlugin = fastifyTrpcPlugin();

/** Opt-in tRPC for the Fastify host; the routers and context factory the plugin requires join through it. */
export const trpcFastify = providePlugs([trpcFastifyPlugin]);
