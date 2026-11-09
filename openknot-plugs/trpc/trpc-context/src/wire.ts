import type { ActorAuthenticationMiddleware, TrpcContextFactory } from "./index.ts";
import { actorAuthentication, createTrpcContext } from "./index.ts";
import type { ExecutionActor } from "@openknot-ts/flow";
import { executionActorResolver } from "@openknot-ts/flow/wire";
import { trace } from "@openknot-ts/tracing/wire";
import { optional, providePlugs, unit } from "@openknot-ts/wire";

/** Keep application actor augmentation intact across declaration emission. */
export interface TrpcAuthenticationMiddleware extends ActorAuthenticationMiddleware<ExecutionActor> {}

/** Shared native context reference; each application resolves its own optional capabilities. */
export const trpcContextFactory = unit({
  requirements: { tracing: optional(trace) },
  factory: ({ tracing }): TrpcContextFactory => createTrpcContext({ tracing }),
});

/** Optional to select, but a protected procedure always requires its configured identity implementation. */
export const trpcAuthentication = unit({
  requirements: { resolve: executionActorResolver },
  factory: ({ resolve }): TrpcAuthenticationMiddleware => actorAuthentication(resolve),
});

/** Lists the context factory for adapters that resolve it from the application, such as a Fastify plugin. */
export const trpcContext = providePlugs([trpcContextFactory]);
