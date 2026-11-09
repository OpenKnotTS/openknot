import type { TrpcAuthenticationContext } from "./index.ts";
import type { ActorResolver } from "@openknot-ts/flow";
import { ActorAuthenticationError } from "@openknot-ts/flow";
import type { TRPCDefaultErrorShape, TRPCMiddlewareFunction } from "@trpc/server";
import { TRPCError } from "@trpc/server";

/** A native middleware that supplies a verified, non-null actor to later resolvers. */
export type ActorAuthenticationMiddleware<Actor> = TRPCMiddlewareFunction<
  Pick<TrpcAuthenticationContext, "authenticate" | "signal">,
  object,
  object,
  { readonly actor: NonNullable<Actor> },
  unknown
>;

/** The same middleware instance shares verification within one request or WebSocket connection. */
export function actorAuthentication<Actor>(resolve: ActorResolver<Actor>): ActorAuthenticationMiddleware<Actor> {
  const requests = new WeakMap<object, Promise<NonNullable<Actor>>>();

  return async ({ ctx, next }) => {
    let actor: NonNullable<Actor>;

    try {
      ctx.signal.throwIfAborted();
      let pending = requests.get(ctx);

      if (pending === undefined) {
        pending = ctx.authenticate(resolve).then((value) => {
          if (value === undefined || value === null) {
            throw ActorAuthenticationError();
          }
          return value;
        });
        requests.set(ctx, pending);
        // Only the credential's own answer is shared: a verification that could not finish, such as an unreachable key
        // set, is tried again by the next protected procedure, which matters for a long-lived WebSocket context.
        pending.catch((error: unknown) => {
          if (!ActorAuthenticationError.is(error) && requests.get(ctx) === pending) {
            requests.delete(ctx);
          }
        });
      }

      actor = await pending;
      ctx.signal.throwIfAborted();
    } catch (cause) {
      if (ctx.signal.aborted) {
        throw new TRPCError({ code: "CLIENT_CLOSED_REQUEST", cause });
      }
      if (ActorAuthenticationError.is(cause)) {
        throw new TRPCError({ code: "UNAUTHORIZED", cause });
      }
      throw cause;
    }

    return next({ ctx: { actor } });
  };
}

/** Only these public fields cross the transport; native causes and credentials stay on the server. */
export interface AuthenticationFailure {
  readonly type: "ActorAuthenticationError";
  readonly message: string;
}

export type AuthenticationErrorShape<Shape extends TRPCDefaultErrorShape> = Omit<Shape, "data"> & {
  readonly data: Shape["data"] & { readonly authenticationError: AuthenticationFailure | null };
};

/** Also usable inside a consumer's native formatter, preserving its existing shape and data. */
export function authenticationErrorFormatter<Shape extends TRPCDefaultErrorShape>({
  shape,
  error,
}: {
  readonly shape: Shape;
  readonly error: TRPCError;
}): AuthenticationErrorShape<Shape> {
  return {
    ...shape,
    data: {
      ...shape.data,
      authenticationError: ActorAuthenticationError.is(error.cause)
        ? { type: "ActorAuthenticationError", message: error.cause.message }
        : null,
    },
  };
}
