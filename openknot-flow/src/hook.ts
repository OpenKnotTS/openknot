import type { Requirements, ResolvedRequirements } from "./definitions.ts";
import { snapshotRequirements } from "./definitions.ts";
import type { FlowExecutionError } from "./errors.ts";
import type { ExecutionActor } from "./execution.ts";
import { integration } from "./internal/integration.ts";
import type { TagOptions } from "./internal/tag.ts";
import { snapshotTag } from "./internal/tag.ts";
import type { ErrorOf, Outcome } from "@openknot-ts/behavior";
import { declarable } from "@openknot-ts/behavior/internal/declarable";
import { executable } from "@openknot-ts/behavior/internal/executable";
import { hasMarker } from "@openknot-ts/wire/internal/marker";
import type { NoRequirements, RequirementsOptions } from "@openknot-ts/wire/internal/requirements";

export const HookMarker = Symbol.for("@openknot-ts/flow/hook");
export const HookRun = Symbol.for("@openknot-ts/flow/hook-run");

export type HookResult = Outcome<void, Error> | PromiseLike<Outcome<void, Error>>;

export interface HookExecutionContext {
  readonly signal: AbortSignal;
  readonly actor: ExecutionActor | undefined;
}

export type HookContext<R extends Requirements> = ResolvedRequirements<R> & HookExecutionContext;

export interface HookDefinition<I = never> extends TagOptions {
  readonly [HookMarker]: true;
  readonly kind: "hook";
  readonly requirements: Requirements;
  readonly [HookRun]: (input: I, ctx: never) => HookResult;
}

export interface Hook<I, R extends Requirements, O extends HookResult> extends HookDefinition<I> {
  readonly requirements: R;
  readonly [HookRun]: (input: I, ctx: HookContext<R>) => O;
}

export type ResolvedHook<I, E extends Error = Error> = (
  input: I,
  ctx: HookExecutionContext,
) => Promise<Outcome<void, E | FlowExecutionError>>;

export type HookErrors<H> = H extends Hook<infer _I, infer _R, infer O> ? ErrorOf<Awaited<O>> : never;

export interface HookFactory<I> {
  <const R extends Requirements = NoRequirements, O extends HookResult = HookResult>(
    options: RequirementsOptions<R> &
      TagOptions & {
        readonly run: (input: I, ctx: HookContext<R>) => O;
      },
  ): Hook<I, R, O>;
}

/** The input goes on the head, `hook<Input>()({ ... })`; `hook({ ... })` takes none. */
export interface HookConstructor extends HookFactory<void> {
  <I = void>(): HookFactory<I>;
}

function createHook<I, const R extends Requirements, O extends HookResult>(
  options: RequirementsOptions<R> &
    TagOptions & {
      readonly run: (input: I, ctx: HookContext<R>) => O;
    },
): Hook<I, R, O> {
  return executable({
    marker: HookMarker as typeof HookMarker,
    kind: "hook",
    hook: HookRun as typeof HookRun,
    run: options.run,
    invalidRunMessage: "hook() requires run()",
    integration,
    define: () => ({
      requirements: snapshotRequirements(options.requirements, ["actor", "__environment"]),
      ...snapshotTag(options),
    }),
  });
}

export const hook = declarable<HookConstructor>(createHook);

export function isHook(value: unknown): value is HookDefinition {
  return hasMarker(value, HookMarker);
}
