import type { BehaviorResolved } from "./internal/resolved.ts";
import type { OperationDefinition } from "./operation.ts";
import type { Reader, ReaderBinding, ReaderDefinition, ReaderComposition, ReaderFunction } from "./reader.ts";
import type { Plug, Requirements, ResolvedReferences } from "@openknot-ts/wire";
import type { BindPort } from "@openknot-ts/wire/internal/marker";

type ReaderPorts = ReaderDefinition | ReaderComposition;
type ReaderBindingFor<P> = P extends Reader<infer F extends ReaderFunction> ? ReaderBinding<F> : never;

/** What a reader binds: the implementation a reader plug's bind() returns for it. */
type ReaderImplementation<P> = P extends { readonly [BindPort]: (implementation: infer I) => unknown } ? I : never;
type ReaderImplementations<P> =
  P extends ReaderComposition<infer M>
    ? { readonly [K in keyof M]: ReaderImplementation<M[K]> }
    : ReaderImplementation<P>;

type ReaderBindings<P> =
  P extends ReaderComposition<infer M> ? { readonly [K in keyof M]: ReaderBindingFor<M[K]> } : ReaderBindingFor<P>;

export type { BehaviorResolved } from "./internal/resolved.ts";

/** Type mappings are enabled by this optional wire entry. */
declare const BehaviorPlugOptions: unique symbol;

declare module "@openknot-ts/wire" {
  interface PlugOptions<_P extends object, _R extends Requirements> {
    readonly [BehaviorPlugOptions]: _P extends ReaderPorts
      ? {
          readonly bind: (dependencies: ResolvedReferences<_R>) => ReaderImplementations<_P>;
        }
      : never;
  }

  interface DefinitionTypes {
    readonly behavior: OperationDefinition | ReaderDefinition;
  }

  interface ContractKinds {
    readonly reader: true;
  }

  interface DefinitionResults<_D> {
    readonly behavior: _D extends Plug<infer P, infer _R>
      ? P extends ReaderPorts
        ? ReaderBindings<P>
        : never
      : BehaviorResolved<_D>;
  }
}

export { provideBehavior } from "./compose.ts";
export type { BehaviorSource, ProvidedBehavior } from "./compose.ts";
