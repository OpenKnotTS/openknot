import type { ExecutionActor, ExecutionInvoker, ExecutionOptions } from "./execution.ts";
import type { ExposureDefinition, ExposureInvoker } from "./exposure.ts";
import type { InputField } from "./guard.ts";
import type { HandlerDefinition, HandlerInput, HandlerResult } from "./handlers.ts";
import { inputExecution } from "./handlers.ts";
import { integration } from "./internal/integration.ts";
import type { FlowResolved } from "./internal/resolved.ts";
import type { TagOptions } from "./internal/tag.ts";
import { snapshotTag } from "./internal/tag.ts";
import type { Outcome, SuccessOf } from "@openknot-ts/behavior";
import { declarable } from "@openknot-ts/behavior/internal/declarable";
import { executable } from "@openknot-ts/behavior/internal/executable";
import { hasMarker, InputMarker } from "@openknot-ts/wire/internal/marker";
import type { NoRequirements, RequirementsOptions } from "@openknot-ts/wire/internal/requirements";
import { snapshotRequirements as snapshotReferences } from "@openknot-ts/wire/internal/requirements";

export const InputPortMarker = Symbol.for("@openknot-ts/flow/input-port");
export const InputRun = Symbol.for("@openknot-ts/flow/input-run");

export type Requirements = Readonly<Record<string, object>>;

/** Optional integrations supply type mappings without importing a runtime. */
export interface RequirementResults<_D> {}
export type ResolvedRequirement<D> = D extends unknown
  ? [FlowResolved<D>] extends [never]
    ? RequirementResults<D>[keyof RequirementResults<D>]
    : FlowResolved<D>
  : never;
export type ResolvedRequirements<R extends Requirements> = {
  readonly [K in keyof R]: ResolvedRequirement<R[K]>;
};

interface TimeUnits {
  readonly milliseconds?: number;
  readonly seconds?: number;
  readonly minutes?: number;
  readonly hours?: number;
  readonly days?: number;
}

export type Duration = {
  [K in keyof TimeUnits]-?: Required<Pick<TimeUnits, K>> & Omit<TimeUnits, K>;
}[keyof TimeUnits];

export type Schedule =
  | { readonly every: Duration; readonly cron?: never; readonly timeZone?: never }
  | { readonly cron: string; readonly timeZone: string; readonly every?: never };

export type Overlap = "skip" | "allow";

/** Epoch milliseconds, as `Date.now()` returns. The `& {}` keeps this name in editor hovers. */
export type Timestamp = number & {};

export interface SchedulerTrigger {
  readonly scheduledAt: Timestamp;
}

export interface ListenerTrigger {
  readonly messageId?: string;
  /** One-based delivery attempt, when the source provides it. */
  readonly attempt?: number;
}

export type ExecutionContext<R extends Requirements, T> = ResolvedRequirements<R> & {
  readonly trigger: T;
  readonly actor: ExecutionActor | undefined;
  readonly signal: AbortSignal;
};

export type InputResult<Output = unknown> = Outcome<Output, Error> | PromiseLike<Outcome<Output, Error>>;

export interface InputPortDefinition extends TagOptions {
  readonly [InputPortMarker]: true;
  readonly [InputMarker]: true;
  readonly kind: "scheduler" | "listener" | "expose";
  readonly requirements: Requirements;
  readonly [InputRun]: (input: never, ctx: never) => InputResult;
}

export interface Scheduler<R extends Requirements, O extends InputResult> extends InputPortDefinition {
  readonly kind: "scheduler";
  readonly schedule: Schedule;
  readonly overlap: Overlap;
  readonly requirements: R;
  readonly [InputRun]: (input: void, ctx: ExecutionContext<R, SchedulerTrigger>) => O;
}

export interface Listener<I, R extends Requirements, O extends InputResult> extends InputPortDefinition {
  readonly kind: "listener";
  readonly requirements: R;
  readonly [InputRun]: (input: I, ctx: ExecutionContext<R, ListenerTrigger>) => O;
}

export interface SchedulerRequest extends ExecutionOptions {
  readonly trigger: SchedulerTrigger;
}

export type ListenerRequest<I> = InputField<I> & ExecutionOptions & { readonly trigger?: ListenerTrigger };

export interface SkippedInvocation {
  readonly status: "skipped";
  readonly reason: "overlap";
}

export type InputInvoker<P> = P extends ExposureDefinition
  ? ExposureInvoker<P>
  : P extends Scheduler<infer _R, infer O>
    ? ExecutionInvoker<SchedulerRequest, SuccessOf<Awaited<O>> | SkippedInvocation>
    : P extends Listener<infer I, infer _R, infer O>
      ? ExecutionInvoker<ListenerRequest<I>, SuccessOf<Awaited<O>>>
      : never;

const reserved = new Set([
  "port",
  "invoke",
  "signal",
  "trigger",
  "__inputPort",
  "actor",
  "__proto__",
  "constructor",
  "prototype",
]);

export function snapshotRequirements<const R extends Requirements = NoRequirements>(
  requirements: R | undefined,
  contextKeys: readonly string[] = [],
): R {
  return snapshotReferences(requirements, {
    reserved: contextKeys.length === 0 ? reserved : new Set([...reserved, ...contextKeys]),
  });
}

export function intervalMilliseconds(every: Duration): number {
  const factors: Readonly<Record<string, number>> = {
    milliseconds: 1,
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
  };
  if (typeof every !== "object" || every === null || Object.keys(every).length === 0) {
    throw new TypeError("An interval requires at least one positive time unit");
  }

  let duration = 0;

  for (const [unit, count] of Object.entries(every)) {
    const factor = factors[unit];
    if (factor === undefined || typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      throw new TypeError(`Invalid interval unit: ${unit}`);
    }
    duration += factor * count;
  }

  if (!Number.isFinite(duration) || duration < 1 || duration > Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Interval must be between 1 and Number.MAX_SAFE_INTEGER milliseconds");
  }

  return duration;
}

function snapshotSchedule(schedule: Schedule): Schedule {
  if (typeof schedule !== "object" || schedule === null) {
    throw new TypeError("A scheduler requires a schedule");
  }

  if (schedule.every !== undefined) {
    if ("cron" in schedule || "timeZone" in schedule) {
      throw new TypeError("Use every or cron/timeZone, not both");
    }

    intervalMilliseconds(schedule.every);
    return Object.freeze({ every: Object.freeze({ ...schedule.every }) });
  }

  if (
    typeof schedule.cron !== "string" ||
    schedule.cron.trim().length === 0 ||
    typeof schedule.timeZone !== "string" ||
    schedule.timeZone.length === 0
  ) {
    throw new TypeError("A cron schedule requires an expression and explicit timeZone");
  }

  new Intl.DateTimeFormat("en", { timeZone: schedule.timeZone });

  return Object.freeze({ cron: schedule.cron, timeZone: schedule.timeZone });
}

interface ScheduleOptions extends TagOptions {
  readonly schedule: Schedule;
  readonly overlap?: Overlap;
}

/** Forward each tick to one handler that takes no input. */
export function scheduler<const H extends HandlerDefinition>(
  options: ScheduleOptions & { readonly handler: H & (void extends HandlerInput<H> ? unknown : never) },
): Scheduler<{ readonly handler: H }, HandlerResult<H>>;

export function scheduler<const R extends Requirements = NoRequirements, O extends InputResult = InputResult>(
  options: RequirementsOptions<R> &
    ScheduleOptions & {
      readonly run: (input: void, ctx: ExecutionContext<R, SchedulerTrigger>) => O;
    },
): Scheduler<R, O>;

export function scheduler(options: ScheduleOptions): InputPortDefinition {
  if ("guards" in options) {
    throw new TypeError("Internal schedulers do not accept guards");
  }

  const port = inputExecution(options, "scheduler");

  const definition = executable({
    marker: InputPortMarker,
    kind: "scheduler",
    hook: InputRun,
    run: port.run as InputPortDefinition[typeof InputRun],
    invalidRunMessage: "A scheduler requires run() or handler",
    integration,
    define: () => {
      const overlap = options.overlap ?? "skip";
      if (overlap !== "skip" && overlap !== "allow") {
        throw new TypeError("Unknown overlap policy");
      }
      const requirements = snapshotRequirements(port.requirements);
      return {
        requirements,
        schedule: snapshotSchedule(options.schedule),
        overlap,
        ...snapshotTag(options),
        [InputMarker]: true as const,
      };
    },
  });

  return definition;
}

export interface ListenerFactory<I> {
  <const R extends Requirements = NoRequirements, O extends InputResult = InputResult>(
    options: RequirementsOptions<R> &
      TagOptions & {
        readonly run: (input: I, ctx: ExecutionContext<R, ListenerTrigger>) => O;
      },
  ): Listener<I, R, O>;
}

/** The message type goes on the head, `listener<Message>()({ ... })`; `listener({ handler })` infers it. */
export interface ListenerConstructor extends ListenerFactory<void> {
  <I = void>(): ListenerFactory<I>;
  /** Forward each message to one handler. */
  <const H extends HandlerDefinition>(
    options: TagOptions & {
      readonly handler: H;
    },
  ): Listener<HandlerInput<H>, { readonly handler: H }, HandlerResult<H>>;
}

function createListener(options: TagOptions): InputPortDefinition {
  if ("guards" in options) {
    throw new TypeError("Internal listeners do not accept guards");
  }

  const port = inputExecution(options, "listener");

  const definition = executable({
    marker: InputPortMarker,
    kind: "listener",
    hook: InputRun,
    run: port.run as InputPortDefinition[typeof InputRun],
    invalidRunMessage: "A listener requires run() or handler",
    integration,
    define: () => ({
      requirements: snapshotRequirements(port.requirements),
      ...snapshotTag(options),
      [InputMarker]: true as const,
    }),
  });

  return definition;
}

export const listener = declarable<ListenerConstructor>(createListener);

export function isInputPort(value: unknown): value is InputPortDefinition {
  return (
    hasMarker(value, InputPortMarker) &&
    "kind" in value &&
    (value.kind === "scheduler" || value.kind === "listener" || value.kind === "expose")
  );
}
