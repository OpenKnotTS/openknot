import type { PropagationCarrier, TraceAttributes, TraceSpan, Tracing } from "@openknot-ts/tracing";
import { withTrace } from "@openknot-ts/tracing";

/** Where Flow traces; the vocabulary stays in Flow and reaches implementations as neutral spans. */
export type ExecutionTraceKind =
  | "expose"
  | "listener"
  | "scheduler"
  | "command"
  | "query"
  | "guard"
  | "hook"
  | "unit-of-work"
  | "publish"
  | "subscribe";

export interface ExecutionTrace {
  readonly kind: ExecutionTraceKind;
  readonly reference: object;
  readonly propagation?: PropagationCarrier | undefined;
  readonly attributes?: TraceAttributes | undefined;
}

/** Listener deliveries and scheduler ticks start independent traces; other executions stay local. */
const roles: Readonly<Partial<Record<ExecutionTraceKind, Pick<TraceSpan, "kind" | "root">>>> = Object.freeze({
  listener: Object.freeze({ kind: "consumer", root: true }),
  scheduler: Object.freeze({ root: true }),
});

/** A returned failed Outcome marks the span, as a thrown error does. */
function outcomeError(value: unknown): unknown {
  return typeof value === "object" && value !== null && "isError" in value && value.isError === true && "error" in value
    ? value.error
    : undefined;
}

/** Without an implementation the work runs as it is, with no wrapper of its own. */
export function traceExecution<T>(
  tracing: Tracing | undefined,
  operation: ExecutionTrace,
  work: () => Promise<T>,
): Promise<T> {
  if (tracing === undefined) {
    return work();
  }

  return withTrace(
    tracing,
    {
      name: `openknot.${operation.kind}`,
      ...roles[operation.kind],
      reference: operation.reference,
      propagation: operation.propagation,
      attributes: { "openknot.execution.kind": operation.kind, ...operation.attributes },
      failure: outcomeError,
    },
    work,
  );
}
