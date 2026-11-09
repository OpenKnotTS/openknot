import { trpcHandler } from "../src/index.ts";
import { reader, success } from "@openknot-ts/behavior";
import { expose, query } from "@openknot-ts/flow";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import "@openknot-ts/behavior/wire";
import type { Resolved } from "@openknot-ts/wire";
import "@openknot-ts/flow/wire";
import { initTRPC } from "@trpc/server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import type { RequestListener } from "node:http";

const context = unit({
  factory:
    () =>
    async ({ req }: CreateHTTPContextOptions) => ({ token: req.headers.authorization ?? "" }),
});
const router = unit({ factory: () => initTRPC.context<{ token: string }>().create().router({}) });
export const handler = trpcHandler({
  router,
  createContext: context,
  basePath: "/rpc/",
  allowMethodOverride: true,
  batching: { enabled: false },
  onError({ ctx }) {
    const token: string | undefined = ctx?.token;
    void token;
    // @ts-expect-error Native callbacks retain the router's actual context type.
    void ctx?.tenant;
  },
  responseMeta: () => ({ headers: { "x-test": "typed" } }),
});
const expectedContext: typeof context = handler.requirements.createContext;
const expectedRouter: typeof router = handler.requirements.router;
declare const native: Resolved<typeof handler>;
const requestListener: RequestListener = native;
void expectedContext;
void expectedRouter;
void requestListener;

// @ts-expect-error Routers with required context retain tRPC's required createContext check.
trpcHandler({ router });
const wrongContext = unit({ factory: () => () => ({ token: 1 }) });
// @ts-expect-error A context provider must resolve the router's context shape.
trpcHandler({ router, createContext: wrongContext });
const wrongArgument = unit({ factory: () => (_value: number) => ({ token: "token" }) });
// @ts-expect-error The context factory accepts native HTTP context arguments.
trpcHandler({ router, createContext: wrongArgument });
// @ts-expect-error DI references are required, rather than already resolved routers.
trpcHandler({ router: initTRPC.create().router({}) });

const anonymous = unit({ factory: () => initTRPC.create().router({}) });
export const anonymousHandler = trpcHandler({ router: anonymous });

const settings = unit({ factory: () => ({ prefix: "/native/" }) });
const configuredHandler = trpcHandler({
  router,
  createContext: context,
  requirements: { settings },
  options: ({ settings }) => ({
    basePath: settings.prefix,
    onError({ ctx }) {
      const token: string | undefined = ctx?.token;
      // @ts-expect-error Config mapping preserves the router's exact context type.
      void ctx?.missing;
      void token;
    },
  }),
});
const configuredSettings: typeof settings = configuredHandler.requirements.settings;
void configuredSettings;

const read = reader<() => string>();
const entry = expose({ handler: query({ requirements: { read }, run: (_, { read }) => success(read()) }) });
const needsReader = unit({
  requirements: { entry },
  factory: ({ entry }) =>
    initTRPC.create().router({ read: initTRPC.create().procedure.query(() => entry({ input: undefined })) }),
});
const needsHandler = trpcHandler({ router: needsReader });
const missing = defineApplication({ modules: [providePlugs([needsHandler])] });
// @ts-expect-error The helper retains the router's transitive unbound reader requirement.
void runApplication(missing);

// The handler's own requirement names stay reserved beside an application's requirements.
trpcHandler({
  router,
  // @ts-expect-error No overload accepts an application requirement named like the handler's router.
  createContext: context,
  requirements: { router: unit({ factory: () => "/rpc/" }) },
  options: () => ({}),
});
