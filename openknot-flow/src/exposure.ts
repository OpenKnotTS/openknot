import type { InputPortDefinition, InputResult, Requirements, ResolvedRequirements } from "./definitions.ts";
import { InputRun, InputPortMarker, snapshotRequirements } from "./definitions.ts";
import type { FlowExecutionError } from "./errors.ts";
import type { ExecutionInvoker, ExecutionActor } from "./execution.ts";
import type { GuardOptions, GuardRequest, Guards, NoGuards } from "./guard.ts";
import { guardedReferences, snapshotGuardOptions } from "./guard.ts";
import type { HandlerDefinition, HandlerErrors, HandlerInput, HandlerOutput, HandlerResult } from "./handlers.ts";
import { command, inputExecution, isHandler, query } from "./handlers.ts";
import { integration } from "./internal/integration.ts";
import type { Outcome, SuccessOf } from "@openknot-ts/behavior";
import type { Composition } from "@openknot-ts/behavior/internal/composable";
import { composable } from "@openknot-ts/behavior/internal/composable";
import { declarable } from "@openknot-ts/behavior/internal/declarable";
import { executable } from "@openknot-ts/behavior/internal/executable";
import { DefinitionIntegrationMarker, hasMarker, InputMarker } from "@openknot-ts/wire/internal/marker";
import type { NoRequirements, RequirementsOptions } from "@openknot-ts/wire/internal/requirements";

export type ExposureContext<R extends Requirements> = ResolvedRequirements<R> & {
  readonly signal: AbortSignal;
  readonly actor: ExecutionActor | undefined;
};

export interface ExposureDefinition extends InputPortDefinition {
  readonly kind: "expose";
  readonly guards: Guards;
}

export interface Exposure<
  I,
  R extends Requirements,
  G extends Guards,
  O extends InputResult,
> extends ExposureDefinition {
  readonly requirements: R;
  readonly guards: G;
  readonly [InputRun]: (input: I, ctx: ExposureContext<R>) => O;
}

export type ExposureRequest<I, G extends Guards = NoGuards> = GuardRequest<I, G>;
export type ExposureInvoker<P> =
  P extends Exposure<infer I, infer _R, infer G, infer O>
    ? ExecutionInvoker<ExposureRequest<I, G>, SuccessOf<Awaited<O>>>
    : never;

type ExposureOptions<I, R extends Requirements, O extends InputResult> = RequirementsOptions<R> & {
  readonly run: (input: I, ctx: ExposureContext<R>) => O;
};

/** Forwarding exposures infer their input, output and errors from the handler. */
type ForwardingExposure<H extends HandlerDefinition, G extends Guards> = Exposure<
  HandlerInput<H>,
  { readonly handler: H },
  G,
  HandlerResult<H>
>;

/** A view is a query whose input accepts the handler's output. */
type ViewOf<H extends HandlerDefinition, V extends HandlerDefinition> = V & { readonly kind: "query" } & ([
    HandlerOutput<H>,
  ] extends [HandlerInput<V>]
    ? unknown
    : { readonly viewInputMustAcceptTheHandlerOutput: HandlerOutput<H> });

/** A viewed exposure takes the handler's input and responds with the view's output and either's errors. */
type ViewedExposure<H extends HandlerDefinition, V extends HandlerDefinition, G extends Guards> = Exposure<
  HandlerInput<H>,
  { readonly handler: H; readonly view: V },
  G,
  Promise<Outcome<HandlerOutput<V>, HandlerErrors<H> | HandlerErrors<V> | FlowExecutionError>>
>;

export interface ExposureFactory<I, Output = unknown> {
  <
    const R extends Requirements = NoRequirements,
    const G extends Guards = Guards,
    O extends InputResult<Output> = InputResult<Output>,
  >(
    options: ExposureOptions<I, R, O> & GuardOptions<G> & { readonly guards: G },
  ): Exposure<I, R, G, O>;
  <const R extends Requirements = NoRequirements, O extends InputResult<Output> = InputResult<Output>>(
    options: ExposureOptions<I, R, O> & GuardOptions<undefined>,
  ): Exposure<I, R, NoGuards, O>;
}

/**
 * A declared contract goes on the head, `expose<Input, Output>()({ ... })`. With nothing to declare,
 * `expose({ ... })` takes no input, and `expose({ handler })` infers the contract from the handler.
 */
export interface ExposureConstructor extends ExposureFactory<void> {
  <I = void, Output = unknown>(): ExposureFactory<I, Output>;
  <const H extends HandlerDefinition, const V extends HandlerDefinition, const G extends Guards = Guards>(
    options: { readonly handler: H; readonly view: ViewOf<H, V> } & GuardOptions<G> & { readonly guards: G },
  ): ViewedExposure<H, V, G>;
  <const H extends HandlerDefinition, const V extends HandlerDefinition>(
    options: { readonly handler: H; readonly view: ViewOf<H, V> } & GuardOptions<undefined>,
  ): ViewedExposure<H, V, NoGuards>;
  <const H extends HandlerDefinition, const G extends Guards = Guards>(
    options: { readonly handler: H } & GuardOptions<G> & { readonly guards: G },
  ): ForwardingExposure<H, G>;
  <const H extends HandlerDefinition>(
    options: { readonly handler: H } & GuardOptions<undefined>,
  ): ForwardingExposure<H, NoGuards>;
}

type Respond = (input: unknown) => Promise<Outcome<unknown, Error>>;

/**
 * A view responds after the handler succeeds: both run as one handler of the handler's kind and Unit of Work, so
 * the view reads the uncommitted writes and its failure rolls them back.
 */
function viewed(options: object): object {
  const { view, ...forwarding } = options as { readonly view: unknown; readonly handler?: unknown };
  const handler = forwarding.handler;

  if (!isHandler(handler)) {
    throw new TypeError("expose() view requires a command() or query() handler");
  }

  if (!isHandler(view) || view.kind !== "query") {
    throw new TypeError("expose() view must be a query()");
  }

  if (view.unitOfWork !== handler.unitOfWork) {
    throw new TypeError("expose() view must use its handler's Unit of Work");
  }

  const requirements = { handler, view };
  const run = async (input: unknown, ctx: { readonly handler: Respond; readonly view: Respond }) => {
    const changed = await ctx.handler(input);
    return changed.isError ? changed : ctx.view(changed.value);
  };
  const definition = { requirements, unitOfWork: handler.unitOfWork, run };

  return {
    ...forwarding,
    handler: handler.kind === "command" ? command<unknown>()(definition) : query<unknown>()(definition),
  };
}

function createExpose(options: GuardOptions<Guards | undefined>): ExposureDefinition {
  const port = inputExecution("view" in options ? viewed(options) : options, "expose");
  const definition = executable({
    marker: InputPortMarker,
    kind: "expose",
    hook: InputRun,
    run: port.run as ExposureDefinition[typeof InputRun],
    invalidRunMessage: "expose() requires run() or handler.",
    integration,
    references: guardedReferences,
    define: () => {
      return {
        requirements: snapshotRequirements(port.requirements),
        ...snapshotGuardOptions(options),
        [InputMarker]: true as const,
      };
    },
  });
  return definition;
}

export function isExposure(value: unknown): value is ExposureDefinition {
  return hasMarker(value, InputPortMarker) && "kind" in value && value.kind === "expose";
}

export const ExposureCompositionMarker = Symbol.for("@openknot-ts/flow/exposure-composition");

export interface ExposureComposition<
  P extends Readonly<Record<string, ExposureDefinition>> = Readonly<Record<string, ExposureDefinition>>,
> extends Composition<typeof ExposureCompositionMarker, "exposure-composition", P> {}

/** Independent ports; this is not a pipeline and does not merge input/guard contracts. */
export const expose: ExposureConstructor & {
  readonly compose: <const P extends Readonly<Record<string, ExposureDefinition>>>(
    members: P,
  ) => ExposureComposition<P>;
} = composable(declarable<ExposureConstructor>(createExpose), {
  name: "expose",
  memberName: "exposure",
  marker: ExposureCompositionMarker,
  kind: "exposure-composition",
  isMember: isExposure,
  metadata: (members) => ({ [DefinitionIntegrationMarker]: integration(members) }),
});

export function isExposureComposition(value: unknown): value is ExposureComposition {
  return hasMarker(value, ExposureCompositionMarker);
}
