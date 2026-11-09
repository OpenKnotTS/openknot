import type { OperationComposition, OperationDefinition } from "./operation.ts";
import { isOperation, isOperationComposition } from "./operation.ts";
import type { CheckedSources, CompositionSource, DeferredModule, Provider, SourceModule } from "@openknot-ts/wire";
import { composeModule, isProvider } from "@openknot-ts/wire";

type BehaviorEntry = OperationDefinition | OperationComposition | Provider<unknown, never, "unit">;

export type BehaviorSource = CompositionSource<BehaviorEntry>;

/** A behavior package's module, passed to defineApplication({ modules }). */
export type ProvidedBehavior<N = any, G = any> = DeferredModule<N, G>;

/** A package provides operations and native units; the consumer's application selects its modules. */
export function provideBehavior<const Sources extends readonly unknown[]>(
  sources: Sources & CheckedSources<Sources, BehaviorSource>,
): SourceModule<Sources> {
  return composeModule({
    sources: sources as readonly BehaviorSource[],
    accepts: (value) =>
      isOperation(value) || isOperationComposition(value) || (isProvider(value) && value.kind === "unit"),
    label: "provideBehavior()",
    members: (entry: BehaviorEntry) => (isOperationComposition(entry) ? Object.values(entry.members) : [entry]),
  }) as SourceModule<Sources>;
}
