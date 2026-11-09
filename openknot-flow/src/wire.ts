import type { InputInvoker, InputPortDefinition } from "./definitions.ts";
import "@openknot-ts/behavior/wire";
import type { GuardDefinition } from "./guard.ts";
import type { HandlerDefinition } from "./handlers.ts";
import type { HookDefinition } from "./hook.ts";
import type { FlowResolved } from "./internal/resolved.ts";
import type { OutputPort, OutputBindings, OutputImplementations } from "./output.ts";
import type { PublisherDefinition } from "./publisher.ts";
import type { SubscriptionDefinition } from "./subscription.ts";
import type { UnitOfWorkDefinition } from "./unit-of-work.ts";
import type { WriterComposition } from "./writer.ts";
import type { WriterDefinition } from "./writer.ts";
import type { ReaderDefinition, ReaderComposition } from "@openknot-ts/behavior";
import type { Resolved, Plug, PlugHandle, Requirements, ResolvedReferences } from "@openknot-ts/wire";

declare module "./definitions.ts" {
  interface RequirementResults<_D> {
    readonly wire: Resolved<_D>;
  }
}
declare const FlowPlugOptions: unique symbol;

declare module "@openknot-ts/wire" {
  interface PlugOptions<_P extends object, _R extends Requirements> {
    readonly [FlowPlugOptions]: _P extends InputPortDefinition
      ? {
          readonly bind: (
            ctx: ResolvedReferences<_R> & {
              readonly port: _P;
              readonly invoke: InputInvoker<_P>;
              readonly signal: AbortSignal;
            },
          ) => PlugHandle | PromiseLike<PlugHandle>;
        }
      : _P extends WriterDefinition | WriterComposition
        ? {
            readonly bind: (dependencies: ResolvedReferences<_R>) => OutputImplementations<_P>;
          }
        : _P extends Exclude<OutputPort, ReaderDefinition | ReaderComposition | WriterDefinition | WriterComposition>
          ? {
              readonly bind: (dependencies: ResolvedReferences<_R>) => OutputImplementations<_P>;
            }
          : never;
  }

  interface DefinitionTypes {
    readonly flow:
      | InputPortDefinition
      | SubscriptionDefinition
      | ReaderDefinition
      | WriterDefinition
      | GuardDefinition
      | PublisherDefinition
      | HandlerDefinition
      | UnitOfWorkDefinition
      | HookDefinition;
  }

  interface ContractKinds {
    readonly writer: true;
    readonly publisher: true;
    readonly topic: true;
    readonly broadcast: true;
  }

  interface DependencyFields<_D> {
    readonly guards: _D extends { readonly guards: infer G } ? G[keyof G] : never;
  }

  interface DefinitionResults<_D> {
    readonly flow: _D extends Plug<infer P, infer _R>
      ? P extends InputPortDefinition
        ? undefined
        : P extends OutputPort
          ? OutputBindings<P>
          : never
      : FlowResolved<_D>;
  }
}

export { provideFlow } from "./compose.ts";
export { actorResolver, executionActorResolver } from "./internal/wire/actor.ts";
export { unitOfWorkChanges } from "./internal/wire/changes.ts";
export { transactional } from "./internal/transactional.ts";
export type {
  CommitListener,
  CommittedChange,
  EntityIdentity,
  EntityKey,
  UnitOfWorkChanges,
} from "./internal/wire/changes.ts";
export type { ActorResolverProvider } from "./internal/wire/actor.ts";
export type { FlowPort, FlowSource, ProvidedFlow } from "./compose.ts";
