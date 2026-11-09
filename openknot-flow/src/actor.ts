import type { ExecutionActor } from "./execution.ts";

export interface ActorResolutionOptions {
  readonly signal?: AbortSignal | undefined;
}

/** Authentication and actor shape belong to the supplied implementation. */
export type ActorResolver<Actor = ExecutionActor> = (
  token: string,
  options?: ActorResolutionOptions,
) => Promise<Actor | undefined>;
