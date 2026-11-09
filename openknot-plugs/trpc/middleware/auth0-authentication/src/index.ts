import type { Auth0ResolverOptions } from "@openknot-ts/auth0-actor";
import { auth0Resolver } from "@openknot-ts/auth0-actor";
import type { ActorAuthenticationMiddleware } from "@openknot-ts/trpc-context";
import { actorAuthentication } from "@openknot-ts/trpc-context";

/** Configure once, then use the same native middleware on HTTP, SSE and WebSocket procedures. */
export function auth0Authentication<Actor>(options: Auth0ResolverOptions<Actor>): ActorAuthenticationMiddleware<Actor> {
  return actorAuthentication(auth0Resolver(options));
}
