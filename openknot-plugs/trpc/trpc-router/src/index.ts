import type { FlowInput, TrpcAuthenticationContext } from "@openknot-ts/trpc-context";
import { authenticationErrorFormatter, flowInput } from "@openknot-ts/trpc-context";
import { collect, isOptionalDependency, unit } from "@openknot-ts/wire";
import type {
  NoRequirements,
  OptionalDependency,
  Provider,
  Requirements,
  RequirementsOptions,
  Resolved,
  ResolvedReferences,
  UnitBinding,
} from "@openknot-ts/wire";
import { initTRPC } from "@trpc/server";
import type {
  AnyTRPCRootTypes,
  AnyTRPCRouter,
  TRPCRootConfig,
  TRPCRouterBuilder,
  TRPCBuiltRouter,
  TRPCDecorateCreateRouterOptions,
  TRPCCreateRouterOptions,
} from "@trpc/server";

/** A consumer may replace this default or supply a different typed reference to each router. */
export const trpc = unit({
  factory: () =>
    initTRPC
      .context<TrpcAuthenticationContext>()
      .create({ isDev: false, errorFormatter: authenticationErrorFormatter }),
});

type TrpcReference = Provider<
  { readonly _config: TRPCRootConfig<AnyTRPCRootTypes>; readonly router: TRPCRouterBuilder<AnyTRPCRootTypes> },
  never,
  "unit"
>;

type RootOf<T extends TrpcReference> = Resolved<T>["_config"]["$types"];
type RouterRequirements<T extends TrpcReference, R extends Requirements> = Omit<R, "trpc"> & { readonly trpc: T };
type NativeRouter<T extends TrpcReference, Routes extends TRPCCreateRouterOptions> = TRPCBuiltRouter<
  RootOf<T>,
  TRPCDecorateCreateRouterOptions<Routes>
>;
type TrpcOption<T extends TrpcReference> = { readonly trpc?: T } & (T extends typeof trpc
  ? unknown
  : { readonly trpc: T });

type RouteDependency<D> = [FlowInput<D>] extends [never] ? Resolved<D> : FlowInput<D>;

/** What routes() receives: resolved values, with each Flow input ready as a native tRPC resolver. */
export type RouteDependencies<R extends Requirements> = {
  readonly [K in keyof R]: R[K] extends OptionalDependency<infer D>
    ? RouteDependency<D> | undefined
    : RouteDependency<R[K]>;
};

function routeDependencies(requirements: Requirements, dependencies: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries(requirements).map(([name, requirement]) => {
      const reference = isOptionalDependency(requirement) ? requirement.reference : requirement;
      const value = dependencies[name];
      return [name, value === undefined ? value : flowInput(reference, value)];
    }),
  );
}

/** Only router units listed by the selected modules join the default root; dependencies do not. */
const declaredRouters = collect.contract<AnyTRPCRouter>();

export type TrpcRouter<
  T extends TrpcReference,
  R extends Requirements,
  Routes extends TRPCCreateRouterOptions,
> = UnitBinding<NativeRouter<T, Routes>, RouterRequirements<T, R>, typeof declaredRouters>;

function defineTrpcRouter<
  const R extends Requirements = NoRequirements,
  const T extends TrpcReference = typeof trpc,
  const Routes extends TRPCCreateRouterOptions = TRPCCreateRouterOptions,
>(
  options: RequirementsOptions<R> &
    TrpcOption<T> & {
      readonly routes: (dependencies: RouteDependencies<RouterRequirements<NoInfer<T>, R>>) => Routes;
    },
): TrpcRouter<T, R, Routes> {
  if (typeof options.routes !== "function") {
    throw new TypeError("trpcRouter() requires routes().");
  }

  if (options.requirements !== undefined && "trpc" in options.requirements) {
    throw new TypeError("Reserved router requirement: trpc");
  }

  const routes = options.routes;

  // The optional reference is permitted only for the default native type.
  const reference = (options.trpc ?? trpc) as T;
  const requirements = { ...options.requirements, trpc: reference } as RouterRequirements<T, R>;

  return unit({
    provides: declaredRouters,
    requirements,
    factory: (dependencies): NativeRouter<T, Routes> => {
      const native = dependencies.trpc as Resolved<T>;
      const build: TRPCRouterBuilder<RootOf<T>> = native.router;
      return build(
        routes(routeDependencies(requirements, dependencies) as RouteDependencies<RouterRequirements<T, R>>),
      );
    },
  });
}

type RouterMembers = Readonly<Record<string, Provider<AnyTRPCRouter, never, "unit">>>;

/** The resolved members a composition merges: its requirements without the tRPC instance. */
type ComposedRoutes<T extends TrpcReference, Members extends RouterMembers> = Omit<
  ResolvedReferences<RouterRequirements<T, Members>>,
  "trpc"
>;

export type TrpcRouterComposition<T extends TrpcReference, Members extends RouterMembers> = TrpcRouter<
  T,
  Members,
  ComposedRoutes<T, Members>
>;

function composeTrpcRouter<const Members extends RouterMembers, const T extends TrpcReference = typeof trpc>(
  options: TrpcOption<T> & { readonly routers: Members },
): TrpcRouterComposition<T, Members> {
  if ("trpc" in options.routers) {
    throw new TypeError("Reserved router member: trpc");
  }

  const reference = (options.trpc ?? trpc) as T;
  const requirements = { ...options.routers, trpc: reference } as RouterRequirements<T, Members>;

  return unit({
    provides: declaredRouters,
    requirements,
    factory: ({ trpc, ...routers }): NativeRouter<T, ComposedRoutes<T, Members>> => {
      const build: TRPCRouterBuilder<RootOf<T>> = trpc.router;
      return build(routers);
    },
  });
}

export const trpcRouter: typeof defineTrpcRouter & { readonly compose: typeof composeTrpcRouter } = Object.freeze(
  Object.assign(defineTrpcRouter, { compose: composeTrpcRouter }),
);

/** Selected router records are merged by the native tRPC implementation, including collision validation. */
export const trpcRootRouter = unit({
  requirements: { trpc, routers: declaredRouters },
  factory: ({ trpc, routers }): AnyTRPCRouter => {
    if (routers.length === 0) {
      throw new Error("Declare at least one trpcRouter in the selected modules.");
    }
    return trpc.mergeRouters(...routers);
  },
});
