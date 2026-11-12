import { InputCancelledError } from "../errors.ts";
import { logRefusal, observeExecution } from "./execution-logs.ts";
import type { InputHost } from "./runtime.ts";
import { isDefect } from "./safety.ts";
import type { ExecutionTrace } from "./tracing.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { reportError } from "@openknot-ts/error-reporting";

type Observer = Pick<InputHost, "tracing" | "logs" | "reporter">;

/** An input's failure, for the application's reporter when one is bound; the caller's own cancellation is none. */
function report(host: Observer, operation: ExecutionTrace, error: Error): void {
  if (InputCancelledError.is(error)) {
    return;
  }
  reportError(host.reporter, {
    error,
    source: `openknot.${operation.kind}`,
    expected: !isDefect(error),
    reference: operation.reference,
    attributes: operation.attributes,
  });
}

/** An input's execution: traced and logged as its kind, its failure reported while its span is still active. */
export function observeInput<T>(
  host: Observer,
  operation: ExecutionTrace,
  work: () => Promise<Outcome<T, Error>>,
): Promise<Outcome<T, Error>> {
  return observeExecution(host.tracing, host.logs, operation, async () => {
    const result = await work();
    if (result.isError) {
      report(host, operation, result.error);
    }
    return result;
  });
}

/** A request an input refused before any execution ran, which no execution record or span covers. */
export function refuseInput(host: Observer, operation: ExecutionTrace, error: Error): void {
  logRefusal(host.logs, operation, error);
  report(host, operation, error);
}
