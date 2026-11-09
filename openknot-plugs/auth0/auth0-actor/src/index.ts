import type { ActorResolver, ExecutionActor } from "@openknot-ts/flow";
import { ActorAuthenticationError } from "@openknot-ts/flow";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { RemoteJWKSetOptions, JWTVerifyOptions } from "jose";

export interface Auth0Claims extends Readonly<Record<string, unknown>> {
  readonly sub: string;
}

export interface Auth0ResolverOptions<Actor = ExecutionActor> {
  readonly issuer: string;
  readonly audience: string;
  /** Native network/cache options; Auth0's issuer determines the discovery URL. */
  readonly jwks?: RemoteJWKSetOptions;
  /** Native verification tuning, while issuer, audience, RS256 and required identity claims stay Auth0 policy. */
  readonly verification?: Omit<JWTVerifyOptions, "issuer" | "audience" | "algorithms" | "requiredClaims"> & {
    readonly requiredClaims?: JWTVerifyOptions["requiredClaims"];
  };
  readonly mapActor: (claims: Auth0Claims, options: { readonly signal: AbortSignal }) => Actor | PromiseLike<Actor>;
}

/** Transport-independent token verification and application-owned actor mapping. */
export function auth0Resolver<Actor>(options: Auth0ResolverOptions<Actor>): ActorResolver<Actor> {
  const { issuer, audience, mapActor } = options;

  const url = new URL(issuer);

  if (url.protocol !== "https:" || audience.trim().length === 0) {
    throw new TypeError("Auth0 requires an HTTPS issuer and a nonempty API audience.");
  }

  if (typeof mapActor !== "function") {
    throw new TypeError("Auth0 requires mapActor().");
  }

  const keys = createRemoteJWKSet(new URL("/.well-known/jwks.json", url), options.jwks);
  const verification = options.verification;

  return async (token, options = {}) => {
    const controller = options.signal === undefined ? new AbortController() : undefined;
    const signal = options.signal ?? controller!.signal;

    try {
      signal.throwIfAborted();

      if (token.length === 0) {
        throw ActorAuthenticationError();
      }

      let claims: Readonly<Record<string, unknown>>;

      try {
        ({ payload: claims } = await jwtVerify(token, keys, {
          ...verification,
          issuer,
          audience,
          algorithms: ["RS256"],
          requiredClaims: [...new Set(["sub", "exp", ...(verification?.requiredClaims ?? [])])],
        }));
      } catch (cause) {
        signal.throwIfAborted();

        if (typeof cause === "object" && cause !== null && "code" in cause) {
          switch (cause.code) {
            case "ERR_JWS_INVALID":
            case "ERR_JWT_INVALID":
            case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
            case "ERR_JWT_EXPIRED":
            case "ERR_JWT_CLAIM_VALIDATION_FAILED":
            case "ERR_JOSE_ALG_NOT_ALLOWED":
            case "ERR_JOSE_NOT_SUPPORTED":
            case "ERR_JWKS_NO_MATCHING_KEY":
              throw ActorAuthenticationError();
            default:
              throw cause;
          }
        }

        throw cause;
      }

      signal.throwIfAborted();

      if (typeof claims.sub !== "string" || claims.sub.length === 0) {
        throw ActorAuthenticationError();
      }

      const actor = await mapActor({ ...claims, sub: claims.sub }, { signal });

      signal.throwIfAborted();

      if (actor === undefined) {
        throw ActorAuthenticationError();
      }

      return actor;
    } finally {
      controller?.abort();
    }
  };
}
