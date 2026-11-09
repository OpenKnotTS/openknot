import type { ExecutionScope, ExecutionScopeOptions } from "./application.ts";
import type { ApplicationStatus } from "./definition.ts";
import type { AnyProvider, Definition } from "./providers.ts";

export interface ProvidedDefinition {
  readonly reference: Definition;
  readonly provider: AnyProvider;
  /** Deferred execution dependencies, as an adapted definition declares them. */
  readonly references?: readonly Definition[];
  /**
   * Its executions open scopes of their own and resolve its deferred references there, as an invoker does: a scope
   * that only resolves this definition acquires nothing for them. Validation still follows them.
   */
  readonly opensScope?: true;
  /** See {@link AdaptedDefinition.pure}. */
  readonly pure?: true;
}

export interface AdaptedDefinition {
  /** Canonical dependency identity, e.g. the contract implemented by a binding. */
  readonly reference: Definition;
  /** Its `required` flag marks a contract without an implementation of its own. */
  readonly provider: AnyProvider;
  /** Discover deferred execution dependencies without capturing their values. */
  readonly references?: readonly Definition[];
  /**
   * Its executions open scopes of their own and resolve its deferred references there, as an invoker does: a scope
   * that only resolves this definition acquires nothing for them. Validation still follows them.
   */
  readonly opensScope?: true;
  /**
   * A resource that brings work in on its own, as a message consumer or a scheduler does. It is acquired before
   * whatever else leads to an execution and released after it, so work already admitted can still reach it.
   */
  readonly source?: true;
  /**
   * Its scoped value depends on nothing but its dependencies, so it is built once per application while none of them,
   * directly or through theirs, is scoped or transient. Its declared lifetime still governs validation.
   */
  readonly pure?: true;
  /** Independent contracts implemented by this definition through native providers. */
  readonly provides?: readonly ProvidedDefinition[];
}

export interface DefinitionAdapterContext {
  readonly status: ApplicationStatus;
  /** Aborts once the application begins stopping, before its shutdown tasks: what lives indefinitely ends on it. */
  readonly stopping: AbortSignal;
  /** From the opening of the intake until it has closed, through shutdown tasks and the drain of hosts and sources. */
  readonly intakeOpen: boolean;
  withScope<T>(
    work: (scope: ExecutionScope) => T | Promise<T>,
    options?: ExecutionScopeOptions & { readonly cleanup?: boolean },
  ): Promise<T>;
}

export interface DefinitionAdapter {
  readonly name: string;
  /** Pure metadata conversion. Return undefined for unrelated module exports. */
  adapt(definition: object, context?: DefinitionAdapterContext): AdaptedDefinition | undefined;
}

export interface DefinitionIntegration {
  readonly name: string;
  readonly references: readonly object[];
  load(): Promise<DefinitionAdapter>;
}
