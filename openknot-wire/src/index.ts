export { config, isConfig } from "./config.ts";
export type { ConnectionWatch } from "./connection.ts";
export { connectionWatch } from "./connection.ts";
export { decorate, isDecoration } from "./decorations.ts";
export { isOptionalDependency, optional } from "./dependencies.ts";
export { hook, isProvider, resource, unit } from "./providers.ts";

export type { Config, ConfigValues, ConfigVariable, ConfigVariables, Environment } from "./config.ts";

export type {
  ContractKinds,
  DependencyFields,
  GivesOf,
  Graph,
  ImplementedContracts,
  MissingImplementations,
  Need,
  NeedsOf,
  TargetedRoot,
} from "./graph.ts";

export type { Decoration } from "./decorations.ts";

export type { OptionalDependency } from "./dependencies.ts";

export type {
  AnyProvider,
  ApplicationHook,
  CancellationOptions,
  CollectionContract,
  Definition,
  DefinitionResults,
  DefinitionTypes,
  Lifetime,
  ManagedResource,
  Provider,
  ProviderArguments,
  ProviderDependencies,
  ProviderOptions,
  Requirement,
  Requirements,
  Resolved,
  ResolvedReferences,
  ResourceHandle,
  ResourceOptions,
  UnitBinding,
  UnitContract,
} from "./providers.ts";

export type { NoRequirements, RequirementsOptions } from "./internal/requirements.ts";
export { DefinitionIntegrationMarker } from "./internal/marker.ts";

export type {
  AdaptedDefinition,
  DefinitionAdapter,
  DefinitionAdapterContext,
  DefinitionIntegration,
  ProvidedDefinition,
} from "./adapters.ts";

export { collect, composeModule, requiredBy } from "./modules.ts";

export type {
  Activation,
  DeferredModule,
  Exclusion,
  ModuleDefinition,
  ModuleExports,
  ModuleInput,
  ModuleSelection,
  ModuleSelectors,
  SourceModule,
} from "./modules.ts";

export { applicationStatus, defineApplication, override } from "./definition.ts";

export type {
  ApplicationCheck,
  ApplicationDefinition,
  ApplicationGives,
  ApplicationOptions,
  ApplicationRoots,
  ApplicationStatus,
  ValueOverride,
} from "./definition.ts";

export { describeApplication } from "./describe.ts";

export type {
  ApplicationDescription,
  DefinitionBinding,
  DefinitionRole,
  DescribedDefinition,
  DescribedDependency,
} from "./describe.ts";

export { runApplication } from "./application.ts";

export type {
  Application,
  ExecutionScope,
  ExecutionScopeOptions,
  RunApplicationOptions,
  ShutdownSignal,
} from "./application.ts";

export type { CheckedSources, CompositionSource } from "./modules.ts";

export { providePlugs } from "./provide-plugs.ts";

export type { PlugSource, ProvidedPlugs } from "./provide-plugs.ts";

export { isPlug, plug } from "./plug.ts";

export type { Plug, PlugDefinition, PlugFactory, PlugHandle, PlugOptions } from "./plug.ts";
