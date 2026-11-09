import type { Auth0ResolverOptions } from "./index.ts";
import { auth0Resolver } from "./index.ts";
import type { ActorResolver, ExecutionActor } from "@openknot-ts/flow";
import { executionActorResolver } from "@openknot-ts/flow/wire";
import type { Provider, ProvidedPlugs, Requirements, RequirementsOptions, ResolvedReferences } from "@openknot-ts/wire";
import { providePlugs, unit } from "@openknot-ts/wire";

/**
 * The module's compile-time graph: it implements the actor resolver and adds no needs, because its binding is
 * conditional and its requirements only decide whether it applies. The application's own check stays in force.
 */
export type Auth0Module = ProvidedPlugs<never, typeof executionActorResolver>;

type Auth0ModuleOptions<R extends Requirements, Actor> = RequirementsOptions<R> & {
  readonly factory: (dependencies: ResolvedReferences<R>) => Auth0ResolverOptions<Actor>;
};

/** Ready native identity mapping, conditional on the application's declared configuration parents. */
export function provideAuth0<const R extends Requirements = {}, Actor extends ExecutionActor = ExecutionActor>(
  options: Auth0ModuleOptions<R, Actor>,
): Auth0Module;

export function provideAuth0<const R extends Requirements, Actor extends ExecutionActor>(
  options: Auth0ModuleOptions<R, Actor>,
): ProvidedPlugs {
  const factory = options.factory;

  if (typeof factory !== "function") {
    throw new TypeError("provideAuth0() requires factory().");
  }

  const binding: Provider<ActorResolver<Actor>, never, "unit"> = unit({
    provides: executionActorResolver,
    whenAvailable: true,
    requirements: options.requirements ?? ({} as R),
    factory: (dependencies: ResolvedReferences<R>) => auth0Resolver(factory(dependencies)),
  });

  return providePlugs([binding]);
}
