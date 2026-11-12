import type { InputResult, Requirements, ResolvedRequirements } from "./definitions.ts";
import { snapshotRequirements } from "./definitions.ts";
import type { FlowExecutionError } from "./errors.ts";
import type { ExecutionActor, ExecutionOptions } from "./execution.ts";
import { integration } from "./internal/integration.ts";
import type { TagOptions } from "./internal/tag.ts";
import { snapshotTag } from "./internal/tag.ts";
import type { UnitOfWorkContext, UnitOfWorkDefinition } from "./unit-of-work.ts";
import { defaultUnitOfWork, isUnitOfWork } from "./unit-of-work.ts";
import type { ErrorOf, Outcome, SuccessOf } from "@openknot-ts/behavior";
import { declarable } from "@openknot-ts/behavior/internal/declarable";
import { executable } from "@openknot-ts/behavior/internal/executable";
import { hasMarker } from "@openknot-ts/wire/internal/marker";
import type { NoRequirements, RequirementsOptions } from "@openknot-ts/wire/internal/requirements";

export const HandlerMarker = Symbol.for("@openknot-ts/flow/handler");
export const HandlerRun = Symbol.for("@openknot-ts/flow/handler-run");

export type HandlerContext<R extends Requirements> = ResolvedRequirements<R> & {
  readonly signal: AbortSignal;
  readonly actor: ExecutionActor | undefined;
  readonly uow: UnitOfWorkContext;
};

export interface HandlerDefinition extends TagOptions {
  readonly [HandlerMarker]: true;
  readonly kind: "command" | "query";
  readonly requirements: Requirements;
  readonly unitOfWork: UnitOfWorkDefinition;
  readonly [HandlerRun]: (input: never, ctx: never) => InputResult;
}

export interface Handler<
  I,
  R extends Requirements,
  O extends InputResult,
  K extends "command" | "query",
> extends HandlerDefinition {
  readonly kind: K;
  readonly requirements: R;
  readonly [HandlerRun]: (input: I, ctx: HandlerContext<R>) => O;
}

/** A resolved handler is called directly, like operations, guards and exposures. */
export type ResolvedHandler<I, O extends InputResult> = (
  input: I,
  options?: ExecutionOptions,
) => Promise<Outcome<SuccessOf<Awaited<O>>, ErrorOf<Awaited<O>> | FlowExecutionError>>;

export type HandlerInput<H extends HandlerDefinition> = Parameters<H[typeof HandlerRun]>[0];
export type HandlerOutput<H extends HandlerDefinition> = SuccessOf<Awaited<ReturnType<H[typeof HandlerRun]>>>;
export type HandlerErrors<H extends HandlerDefinition> = ErrorOf<Awaited<ReturnType<H[typeof HandlerRun]>>>;

/** What calling the resolved handler returns; input ports that forward to it return the same. */
export type HandlerResult<H extends HandlerDefinition> =
  H extends Handler<infer I, infer _R, infer O, infer _K> ? ReturnType<ResolvedHandler<I, O>> : never;

type HandlerOptions<I, R extends Requirements, O extends InputResult> = RequirementsOptions<R> &
  TagOptions & {
    readonly run: (input: I, ctx: HandlerContext<R>) => O;
    readonly unitOfWork?: UnitOfWorkDefinition;
  };

export interface HandlerFactory<I, Output, K extends "command" | "query"> {
  <const R extends Requirements = NoRequirements, O extends InputResult<Output> = InputResult<Output>>(
    options: HandlerOptions<I, R, O>,
  ): Handler<I, R, O, K>;
}

/**
 * A declared contract goes on the head, `command<Input, Output>()({ ... })`, and the second call infers the
 * requirements and errors. With nothing to declare, `command({ ... })` takes no input and infers its output.
 */
export interface HandlerConstructor<K extends "command" | "query"> extends HandlerFactory<void, unknown, K> {
  <I = void, Output = unknown>(): HandlerFactory<I, Output, K>;
}

function factory<K extends "command" | "query">(kind: K): HandlerConstructor<K> {
  const create = <I, const R extends Requirements, O extends InputResult>(
    options: HandlerOptions<I, R, O>,
  ): Handler<I, R, O, K> =>
    executable({
      marker: HandlerMarker as typeof HandlerMarker,
      kind,
      hook: HandlerRun as typeof HandlerRun,
      run: options.run,
      invalidRunMessage: `${kind}() requires run()`,
      integration,
      define: () => ({
        requirements: snapshotRequirements(options.requirements, [
          "actor",
          "uow",
          "__gateway",
          "__uow",
          "__environment",
        ]),
        unitOfWork: snapshotUnitOfWork(options.unitOfWork),
        ...snapshotTag(options),
      }),
      references: (definition) => [...Object.values(definition.requirements), definition.unitOfWork],
    });
  return declarable<HandlerConstructor<K>>(create);
}

export const command = factory("command");
export const query = factory("query");

function snapshotUnitOfWork(value: UnitOfWorkDefinition | undefined): UnitOfWorkDefinition {
  if (value !== undefined && !isUnitOfWork(value)) {
    throw new TypeError("unitOfWork requires a unitOfWork() reference");
  }
  return value ?? defaultUnitOfWork;
}

export function isHandler(value: unknown): value is HandlerDefinition {
  return hasMarker(value, HandlerMarker);
}

/** Input ports either declare requirements and run(), or forward their input to one handler. */
export function inputExecution(
  options: object,
  port: string,
): { readonly requirements: Requirements | undefined; readonly run: unknown } {
  if (!("handler" in options)) {
    return {
      requirements: (options as { readonly requirements?: Requirements }).requirements,
      run: (options as { readonly run?: unknown }).run,
    };
  }

  if ("run" in options || "requirements" in options) {
    throw new TypeError(`${port}() accepts either handler or requirements and run()`);
  }

  const handler = options.handler;

  if (!isHandler(handler)) {
    throw new TypeError(`${port}() handler must be a command() or query()`);
  }

  return {
    requirements: { handler },
    run: (input: unknown, ctx: { readonly handler: (input: unknown) => unknown }) => ctx.handler(input),
  };
}
