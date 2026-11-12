import { UnitOfWorkError } from "../errors.ts";
import type { TraceOptions } from "../execution.ts";
import type { PublisherDefinition } from "../publisher.ts";
import type { SubscriptionDefinition } from "../subscription.ts";
import type { CommitContext } from "../unit-of-work.ts";
import { observeExecution } from "./execution-logs.ts";
import type { ExecutionEnvironment } from "./execution-runtime.ts";
import { plugFailure } from "./safety.ts";
import { isTransactional } from "./transactional.ts";
import type { UnitOfWorkExecutor } from "./uow-runtime.ts";
import type { PropagationCarrier } from "@openknot-ts/tracing";
import { bindTrace, capturePropagation } from "@openknot-ts/tracing";

const Publication = Symbol("publication");

interface PublicationContext {
  readonly signal?: AbortSignal | undefined;
  readonly propagation?: PropagationCarrier | undefined;
}

export type PublishingPort = PublisherDefinition | SubscriptionDefinition;

export function optionsIndex(port: PublishingPort): number {
  return port.kind === "topic" ? 2 : 1;
}

/** One immutable resolved port: publish stages, publishNow explicitly sends immediately. */
export function publication<T extends { readonly publish: (...args: never[]) => Promise<void> }>(
  source: T,
  uow: UnitOfWorkExecutor,
  reference: PublishingPort,
  fallback?: () => PublicationContext,
): T {
  if (Publication in source) {
    return source;
  }

  const index = optionsIndex(reference);
  const messageIndex = index - 1;
  const transactional = isTransactional(source);

  async function publish(args: unknown[], immediate: boolean): Promise<void> {
    const input = (args[index] ?? {}) as TraceOptions;
    const supplied: TraceOptions = {
      ...input,
      ...(input.propagation === undefined ? {} : { propagation: Object.freeze({ ...input.propagation }) }),
      ...(input.traceAttributes === undefined ? {} : { traceAttributes: Object.freeze({ ...input.traceAttributes }) }),
    };
    supplied.signal?.throwIfAborted();

    const signal = uow.executionSignal;
    signal?.throwIfAborted();

    const factory =
      typeof args[messageIndex] === "function"
        ? (args[messageIndex] as (context: CommitContext) => unknown)
        : undefined;

    if (factory !== undefined && (immediate || uow.commitContext === undefined)) {
      throw UnitOfWorkError("Publication factories require an active Unit of Work and publish()");
    }

    const inherited = fallback?.();

    const options = publicationOptions(
      supplied,
      uow.defers(immediate),
      signal ?? inherited?.signal,
      uow.propagation ?? inherited?.propagation,
    );

    const forwarded = [...args];
    const originating = uow.commitContext;

    const send = bindTrace(uow.tracing, async () => {
      if (factory !== undefined) {
        const message = await factory(originating!);

        if (message === undefined) {
          return;
        }

        forwarded[messageIndex] = message;
      }

      await observeExecution(
        uow.tracing,
        uow.logs,
        { kind: "publish", reference, propagation: supplied.propagation, attributes: supplied.traceAttributes },
        async () => {
          const propagation = capturePropagation(uow.tracing) ?? options.propagation;
          forwarded[index] = Object.freeze({
            ...options,
            ...(uow.tracing === undefined ? {} : { tracing: uow.tracing }),
            ...(propagation === undefined ? {} : { propagation }),
          });
          try {
            await source.publish(...(forwarded as never[]));
          } catch (error) {
            throw plugFailure(error, uow.executionSignal);
          }
        },
      );
    });

    await uow.publish(send, immediate, transactional);
  }

  return Object.freeze({
    ...source,
    [Publication]: true,
    publish: (...args: unknown[]) => publish(args, false),
    publishNow: (...args: unknown[]) => publish(args, true),
  }) as T;
}

/** Outside a Unit of Work, publications inherit the scoped execution metadata and signal. */
export function scopedPublication<T extends { readonly publish: (...args: never[]) => Promise<void> }>(
  source: T,
  environment: ExecutionEnvironment,
  reference: PublishingPort,
): T {
  return publication(source, environment.uow, reference, () => ({
    signal: environment.signal,
    propagation: environment.propagation,
  }));
}

function publicationOptions(
  { signal: supplied, ...options }: TraceOptions,
  deferred: boolean,
  signal: AbortSignal | undefined,
  propagation: PropagationCarrier | undefined,
): TraceOptions {
  const cancellation = deferred ? undefined : (supplied ?? signal);

  return Object.freeze({
    ...options,
    ...(options.propagation !== undefined || propagation === undefined ? {} : { propagation }),
    ...(cancellation === undefined ? {} : { signal: cancellation }),
  });
}
