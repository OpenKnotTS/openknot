import type { PropagationCarrier, TraceAttributes, Tracing } from "@openknot-ts/tracing";

/** Applications may augment this interface once to type their execution actor. */
export interface ExecutionTypes {}
export type ExecutionActor = ExecutionTypes extends { readonly actor: infer Actor } ? Actor : unknown;

/** Internal immutable binding; the application owns the actor value and its shape. */
export interface ExecutionIdentity {
  readonly actor: ExecutionActor | undefined;
}
export interface TraceOptions {
  readonly signal?: AbortSignal | undefined;
  readonly propagation?: PropagationCarrier | undefined;
  readonly traceAttributes?: TraceAttributes | undefined;
}

export interface ExecutionOptions extends TraceOptions {
  /** Trusted identity supplied at the input boundary; never serialized by Flow. */
  readonly actor?: ExecutionActor | undefined;
}

/** Application-local capability supplied to native input bindings by Flow. */
export type ExecutionInvoker<Request, Result> = {
  (request: Request): Promise<Result>;
  readonly tracing?: Tracing | undefined;
};
