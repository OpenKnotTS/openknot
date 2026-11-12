/** Serialized remote context; the implementation selects its fields and format. */
export type PropagationCarrier = Readonly<Record<string, string>>;
export type TraceAttributes = Readonly<Record<string, string | number | boolean>>;
/** A span's remote role; a span without a kind is local to its process. */
export type SpanKind = "server" | "client" | "producer" | "consumer";

/** What instrumentation knows about one traced unit of work; native spans, IDs and sampling belong to the implementation. */
export interface TraceSpan {
  readonly name: string;
  readonly kind?: SpanKind | undefined;
  /** Starts an independent trace; a supplied carrier then becomes a link instead of a parent. */
  readonly root?: boolean | undefined;
  /** Remote context to continue, as produced by `capture()` on the other side. */
  readonly propagation?: PropagationCarrier | undefined;
  readonly attributes?: TraceAttributes | undefined;
  /** The definition or resource that opened the span, for application-selected naming. */
  readonly reference?: object | undefined;
  /** Reads a failure the work returned instead of throwing. */
  readonly failure?: ((result: unknown) => unknown) | undefined;
}

/** The active span's identifiers, which logs carry so a backend can join them to the trace. */
export type TraceCorrelation = {
  readonly traceId: string;
  readonly spanId: string;
};

/** OpenKnot's tracing contract: instrumentation describes spans, implementations record and propagate them. */
export interface Tracing {
  /** Carrier fields the implementation reads, so transports select only those. */
  readonly propagationFields?: readonly string[];
  /** The active span's identifiers, also for a span that is not sampled, or undefined outside a span. */
  correlation?(): TraceCorrelation | undefined;
  run<T>(span: TraceSpan, work: () => Promise<T>): Promise<T>;
  capture(): PropagationCarrier | undefined;
  /** Captures the caller's native context for deferred work, including after-commit delivery. */
  bind<T>(work: () => Promise<T>): () => Promise<T>;
}

/** The work, started at most once by whichever of the instrumentation and the fallback calls it first. */
function once<T>(work: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= Promise.resolve().then(work));
}

/**
 * Instrumentation must not fail business work or execute it more than once: whatever the instrumented call does,
 * the work runs once and its own result or rejection is the one returned.
 */
async function shielded<T>(instrumented: () => unknown, run: () => Promise<T>): Promise<T> {
  try {
    await instrumented();
  } catch {
    /* Await the original work, preserving its result or rejection. */
  }
  return run();
}

export async function withTrace<T>(tracing: Tracing | undefined, span: TraceSpan, work: () => Promise<T>): Promise<T> {
  if (tracing === undefined) {
    return work();
  }
  const execute = once(work);
  return shielded(() => tracing.run(span, execute), execute);
}

/** W3C Trace Context, the carrier fields transports select when no implementation names its own. */
const traceContextFields: readonly string[] = Object.freeze(["traceparent", "tracestate"]);

/** The carrier fields a transport reads and writes: the implementation's own, or W3C Trace Context. */
export function propagationFields(tracing: Tracing | undefined): readonly string[] {
  return tracing?.propagationFields ?? traceContextFields;
}

export function traceCorrelation(tracing: Tracing | undefined): TraceCorrelation | undefined {
  try {
    return tracing?.correlation?.();
  } catch {
    return undefined;
  }
}

export function capturePropagation(tracing: Tracing | undefined): PropagationCarrier | undefined {
  try {
    return tracing?.capture();
  } catch {
    return undefined;
  }
}

/**
 * Deferred work in the caller's captured context, such as an after-commit delivery. It runs once: later calls
 * return the same result, and a binding that fails, now or when called, runs it without that context.
 */
export function bindTrace<T>(tracing: Tracing | undefined, work: () => Promise<T>): () => Promise<T> {
  if (tracing === undefined) {
    return work;
  }
  const execute = once(work);
  let bound: () => Promise<T>;
  try {
    bound = tracing.bind(execute);
  } catch {
    return execute;
  }
  return () => shielded(bound, execute);
}
