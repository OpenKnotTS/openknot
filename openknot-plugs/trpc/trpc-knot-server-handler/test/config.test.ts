import { nodeTrpcHandler, trpcHandler } from "../src/index.ts";
import { nodeHttpServer } from "@openknot-ts/knot-http-node";
import { trpcRouter } from "@openknot-ts/trpc-router";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { initTRPC } from "@trpc/server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

test("an application requirement keeps its name beside the adapter's own dependencies", async () => {
  const options = unit({ factory: () => "/mine/" });
  const adapter = nodeTrpcHandler({ requirements: { options }, options: ({ options }) => ({ basePath: options }) });
  const router = trpcRouter({ routes: ({ trpc }) => ({ hello: trpc.procedure.query(() => "native") }) });
  const server = nodeHttpServer({ handler: adapter });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server, router])] }), {
    env: { PORT: "0" },
    stopOn: [],
  });
  try {
    const response = await fetch(`${app.resolve(server).url}/mine/hello`);
    assert.deepEqual([response.status, await response.json()], [200, { result: { data: "native" } }]);
  } finally {
    await app.stop();
  }
});

test("the ready-router Node adapter maps independent native options without default tRPC env", async () => {
  const settings = config({ RPC_PREFIX: z.string().startsWith("/") });
  const adapter = nodeTrpcHandler({
    requirements: { settings },
    options: ({ settings }) => ({
      basePath: settings.RPC_PREFIX,
      responseMeta: () => ({ headers: { "x-native": "custom" } }),
    }),
  });
  const router = trpcRouter({ routes: ({ trpc }) => ({ hello: trpc.procedure.query(() => "native") }) });
  const server = nodeHttpServer({ handler: adapter });
  const definition = defineApplication({ modules: [providePlugs([server, router])] });
  const env = { PORT: "0", RPC_PREFIX: "/native/", TRPC_BASE_PATH: "unused", TRPC_MAX_BODY_SIZE: "unused" };
  await assert.rejects(
    runApplication(definition, { env: { ...env, RPC_PREFIX: "invalid" }, stopOn: [] }),
    /RPC_PREFIX/,
  );
  const app = await runApplication(definition, { env, stopOn: [] });
  try {
    const response = await fetch(`${app.resolve(server).url}/native/hello`);
    assert.deepEqual(
      [response.status, response.headers.get("x-native"), await response.json()],
      [200, "custom", { result: { data: "native" } }],
    );
  } finally {
    await app.stop();
  }
});

test("custom router contexts keep native callback types through requirements-based configuration", async () => {
  const parent = initTRPC.context<{ token: string }>().create();
  const router = unit({ factory: () => parent.router({ who: parent.procedure.query(({ ctx }) => ctx.token) }) });
  const context = unit({
    factory:
      () =>
      ({ req }: CreateHTTPContextOptions) => ({ token: req.headers.authorization ?? "" }),
  });
  const settings = config({ ROUTER_PATH: z.string().startsWith("/") });
  const handler = trpcHandler({
    router,
    createContext: context,
    requirements: { settings },
    options: ({ settings }) => ({
      basePath: settings.ROUTER_PATH,
      allowMethodOverride: true,
      responseMeta: ({ ctx }) => ({ headers: { "x-token": ctx?.token ?? "" } }),
    }),
  });
  const server = nodeHttpServer({ handler });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), {
    env: { PORT: "0", ROUTER_PATH: "/custom/", TRPC_BASE_PATH: "unused" },
    stopOn: [],
  });
  try {
    const response = await fetch(`${app.resolve(server).url}/custom/who`, {
      headers: { authorization: "native-token" },
    });
    assert.deepEqual(
      [response.status, response.headers.get("x-token"), await response.json()],
      [200, "native-token", { result: { data: "native-token" } }],
    );
  } finally {
    await app.stop();
  }
});
