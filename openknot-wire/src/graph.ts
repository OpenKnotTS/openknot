import type { OptionalDependency } from "./dependencies.ts";

/** Optional integrations register the definition kinds that need an implementation of their own. */
export interface ContractKinds {}

/** Optional integrations name the contract that one of their bindings implements. */
export interface ImplementedContracts<_D> {}

/** Optional integrations name dependency fields beyond requirements, such as guards. */
export interface DependencyFields<_D> {}

/** A requirement on a contract that needs an implementation, named as its consumer declared it. */
export interface Need<Name extends string = string, Contract = unknown> {
  readonly name: Name;
  readonly contract: Contract;
}

declare const GraphTypes: unique symbol;

/**
 * Compile-time roots and implemented contracts of a module or application. It exists only in types. The roots
 * are the definitions whose needs count; the needs themselves are computed once the application knows what it
 * overrides, so a shared dependency keeps the needs of every other definition that reaches it.
 * `any` means untracked, which skips the compile-time check while startup validation still applies.
 */
export interface Graph<R = any, G = any> {
  readonly [GraphTypes]: { readonly roots: R; readonly gives: G };
}

type Contract = { readonly kind: keyof ContractKinds } | { readonly required: true };

type IsAny<T> = 0 extends 1 & T ? true : false;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Whether `D` is one of `S`. Types are structural: a definition of exactly the same type as a member is one with it. */
type Among<D, S> = true extends (S extends unknown ? Equal<D, S> : never) ? true : false;

/**
 * The contracts a definition needs, followed through its requirements and integration dependency fields
 * however deep they go, without entering the overridden targets `S`. Each definition's needs are
 * one cached instantiation, and the compiler itself stops at a type that requires itself.
 */
export type NeedsOf<D, S = never> = D extends unknown
  ? Among<D, S> extends true
    ? never
    :
        | (D extends { readonly requirements: infer R } ? RequirementNeeds<R, S> : never)
        | FieldNeeds<DependencyFields<D>[keyof DependencyFields<D>], S>
  : never;

type RequirementNeeds<R, S> = string extends keyof R
  ? never
  : {
      [K in keyof R & string]: R[K] extends OptionalDependency
        ? never
        : Among<R[K], S> extends true
          ? never
          : R[K] extends Contract
            ? Need<K, R[K]> | NeedsOf<R[K], S>
            : NeedsOf<R[K], S>;
    }[keyof R & string];

type FieldNeeds<F, S> = F extends unknown ? NeedsOf<F, S> : never;

type Members<P> = P extends { readonly members: infer M } ? M[keyof M] : P;

/**
 * The contracts a definition implements: a plug's port or composition members, the target of a native
 * provides binding (including the collection contract a member joins), or an integration binding's contract.
 */
export type GivesOf<D> = D extends unknown
  ? D extends { readonly kind: "plug"; readonly port: infer P }
    ? Members<P>
    : D extends { readonly provides: infer C }
      ? C
      : ImplementedContracts<D>[keyof ImplementedContracts<D>]
  : never;

/** Definitions supplied by provision sources: direct values, namespaces and native import loaders. */
export type SourceEntries<S> = S extends (...args: never[]) => PromiseLike<infer Namespace>
  ? Namespace[keyof Namespace]
  : S extends { readonly kind: unknown }
    ? S
    : S extends object
      ? S[keyof S]
      : never;

/** The graph of definitions listed by provision sources or provider namespaces, with compositions expanded. */
export type EntriesGraph<E> = Graph<Members<E>, GivesOf<Members<E>>>;

export type RootsOfGraph<M> = M extends Graph<infer R, infer _G> ? R : never;
export type GivesOfGraph<M> = M extends Graph<infer _R, infer G> ? G : never;

declare const TargetedRootTypes: unique symbol;

/**
 * A root that acts on a target, such as a decoration: it counts while its target, or one of its targets, is not
 * overridden, since an overridden target is a value built from neither.
 */
export interface TargetedRoot<T, D> {
  readonly [TargetedRootTypes]: { readonly target: T; readonly root: D };
}

type ActiveTargets<T, O> = T extends unknown ? (Among<T, O> extends true ? never : T) : never;

type RootNeeds<R, O> =
  R extends TargetedRoot<infer T, infer D>
    ? [ActiveTargets<T, O>] extends [never]
      ? never
      : NeedsOf<D, O>
    : NeedsOf<R, O>;

/**
 * The needs of a graph's roots: overridden targets `O` contribute none of their own, and a targeted root none once
 * all its targets are overridden. Any when the graph is untracked.
 */
export type GraphNeeds<R, O = never> = IsAny<R> extends true ? any : RootNeeds<R, O>;

/** Names of needed contracts without an implementation; never when the graph is untracked. */
export type MissingImplementations<N, G> =
  IsAny<N> extends true
    ? never
    : IsAny<G> extends true
      ? never
      : N extends Need<infer Name, infer C>
        ? Among<C, G> extends true
          ? never
          : Name
        : never;
