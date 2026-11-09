import type { Event } from "../event.ts";
import type { ExecutableOperation, Operation, OperationExecutionResult } from "../operation.ts";
import type { Reader, ReaderBinding, ReaderFunction } from "../reader.ts";

/** Behavior-owned mappings only; no wire import or fallback into another registry. */
export type BehaviorResolved<D> =
  D extends Operation<infer I, infer _R, infer O extends OperationExecutionResult, infer E extends Event>
    ? ExecutableOperation<I, O, E>
    : D extends Reader<infer F extends ReaderFunction> | ReaderBinding<infer F extends ReaderFunction>
      ? F
      : never;
