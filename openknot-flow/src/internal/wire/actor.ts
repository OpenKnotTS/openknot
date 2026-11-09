import type { ActorResolver } from "../../actor.ts";
import type { ExecutionActor } from "../../execution.ts";
import type { ExecutionLifetime } from "../cancellation.ts";
import { executionLifetime } from "../cancellation.ts";
import type { Requirements, RequirementsOptions, ResolvedReferences, UnitBinding } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";

/** Container-local identity capability; protected transports require its implementation explicitly. */
export const executionActorResolver = unit.contract<ActorResolver>();

export type ActorResolverProvider<R extends Requirements, Actor> = UnitBinding<
  ActorResolver<Actor>,
  R,
  typeof executionActorResolver
>;

/** Builds a callable resolver; its dependencies are resolved once, identity per invocation. */
export function actorResolver<const R extends Requirements = {}, Actor extends ExecutionActor = ExecutionActor>(
  options: RequirementsOptions<R> & {
    readonly resolve: (
      token: string,
      ctx: ResolvedReferences<R> & { readonly signal: AbortSignal },
    ) => Actor | undefined | PromiseLike<Actor | undefined>;
  },
): ActorResolverProvider<R, Actor> {
  if (typeof options.resolve !== "function") {
    throw new TypeError("actorResolver() requires resolve().");
  }
  if (options.requirements !== undefined && "signal" in options.requirements) {
    throw new TypeError("Reserved actor resolver requirement: signal");
  }
  const resolve = options.resolve;
  return unit({
    provides: executionActorResolver,
    requirements: options.requirements ?? ({} as R),
    whenAvailable: true,
    factory:
      (dependencies: ResolvedReferences<R>): ActorResolver<Actor> =>
      async (token, options = {}) => {
        let lifetime: ExecutionLifetime | undefined;
        let signal = options.signal;
        if (signal === undefined) {
          lifetime = executionLifetime();
          signal = lifetime.signal;
        }
        try {
          signal.throwIfAborted();
          const actor = await resolve(
            token,
            Object.freeze({ ...dependencies, signal }) as ResolvedReferences<R> & { readonly signal: AbortSignal },
          );
          signal.throwIfAborted();
          return actor;
        } finally {
          lifetime?.end();
        }
      },
  });
}
