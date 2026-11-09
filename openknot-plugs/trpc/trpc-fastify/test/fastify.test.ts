import { fastifyTrpcPlugin, trpcFastify } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { fastifyHttp, fastifyServer } from "@openknot-ts/fastify-server";
import { command, expose, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { trpcRouter } from "@openknot-ts/trpc-router";
import { config, defineApplication, plug, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

test("native Fastify tRPC options can use independent config without default env", async () => {
  const settings = config({ API_RPC_PREFIX: z.string().startsWith("/") });
  const plugin = fastifyTrpcPlugin({
    requirements: { settings },
    options: ({ settings }) => ({
      prefix: settings.API_RPC_PREFIX,
      trpcOptions: { responseMeta: () => ({ headers: { "x-native": "custom" } }) },
    }),
  });
  const { router, greet } = greeting();
  const app = await runApplication(
    defineApplication({
      modules: [fastifyHttp, provideFlow([greet]), providePlugs([router, plugin])],
    }),
    { env: { PORT: "0", API_RPC_PREFIX: "/native", TRPC_BASE_PATH: "unused" }, stopOn: [] },
  );
  try {
    const response = await post(`${app.resolve(fastifyServer).url}/native/greet`, { name: "ada" });
    assert.deepEqual(
      [response.status, response.headers.get("x-native"), await response.json()],
      [200, "custom", { result: { data: "hello ada" } }],
    );
  } finally {
    await app.stop();
  }
});

test("an application requirement keeps its name beside the plugin's own dependencies", async () => {
  const options = unit({ factory: () => "/mine" });
  const plugin = fastifyTrpcPlugin({ requirements: { options }, options: ({ options }) => ({ prefix: options }) });
  const { router, greet } = greeting();
  const app = await runApplication(
    defineApplication({ modules: [fastifyHttp, provideFlow([greet]), providePlugs([router, plugin])] }),
    { env, stopOn: [] },
  );
  try {
    const response = await post(`${app.resolve(fastifyServer).url}/mine/greet`, { name: "ada" });
    assert.deepEqual([response.status, await response.json()], [200, { result: { data: "hello ada" } }]);
  } finally {
    await app.stop();
  }
});

/** The current job keeps the objects it created alive until it ends: two turns of the event loop, then a collection. */
async function collect(): Promise<void> {
  const gc = (globalThis as { gc?: (options: object) => void }).gc ?? assert.fail("run with node --expose-gc");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // A full collection: a single regular cycle can leave unreachable objects behind under load.
  gc({ type: "major", execution: "sync", flavor: "last-resort" });
}

const env = { PORT: "0" };

function greeting() {
  const greet = expose({
    handler: command<{ readonly name: string }, string>()({ run: (input) => success(`hello ${input.name}`) }),
  });
  const router = trpcRouter({
    requirements: { greet },
    routes: ({ trpc, greet }) => ({
      greet: trpc.procedure.input((value) => value as { name: string }).mutation(greet),
    }),
  });
  return { router, greet, modules: [fastifyHttp, trpcFastify, provideFlow([greet]), providePlugs([router])] };
}

function post(url: string, body: unknown, signal?: AbortSignal) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

test("the selected routers answer on the Fastify host under the default or configured base path", async () => {
  for (const [settings, path] of [
    [env, "/trpc/greet"],
    [{ ...env, TRPC_BASE_PATH: "/rpc/" }, "/rpc/greet"],
  ] as const) {
    const app = await runApplication(defineApplication({ modules: greeting().modules }), { env: settings, stopOn: [] });
    try {
      const url = app.resolve(fastifyServer).url;
      const response = await post(`${url}${path}`, { name: "ada" });
      assert.deepEqual([response.status, await response.json()], [200, { result: { data: "hello ada" } }]);
      const elsewhere = path === "/trpc/greet" ? "/rpc/greet" : "/trpc/greet";
      assert.equal((await post(`${url}${elsewhere}`, { name: "ada" })).status, 404);
    } finally {
      await app.stop();
    }
  }
});

test("a client that disconnects cancels its execution, rolls its work back and leaves nothing of it", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const published: number[] = [];
  const kept: WeakRef<object>[] = [];
  const events = publisher<number>();
  const wait = command({
    requirements: { events },
    async run(_input, ctx) {
      kept.push(new WeakRef(ctx));
      await ctx.events.publish(1);
      entered.resolve();
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      cancelled.resolve();
      return success();
    },
  });
  const endpoint = expose({ handler: wait });
  const router = trpcRouter({
    requirements: { endpoint },
    routes: ({ trpc, endpoint }) => ({ wait: trpc.procedure.mutation(endpoint) }),
  });
  const output = plug({ port: events, bind: () => (value) => void published.push(value) });
  const app = await runApplication(
    defineApplication({ modules: [fastifyHttp, trpcFastify, provideFlow([endpoint]), providePlugs([router, output])] }),
    { env, stopOn: [] },
  );
  try {
    const client = new AbortController();
    const response = post(`${app.resolve(fastifyServer).url}/trpc/wait`, null, client.signal);
    await entered.promise;
    client.abort();
    await assert.rejects(response);
    await cancelled.promise;
    // The execution ends once its staged work is discarded, in the turns that follow its cancellation.
    await collect();
    assert.deepEqual(published, []);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.deref(), undefined);
  } finally {
    await app.stop();
  }
});

test("a request the host admitted before the application began stopping still executes its exposure", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const slow = expose({
    handler: command({
      async run() {
        entered.resolve();
        await finish.promise;
        return success("done");
      },
    }),
  });
  const router = trpcRouter({
    requirements: { slow },
    routes: ({ trpc, slow }) => ({ slow: trpc.procedure.mutation(slow) }),
  });
  const app = await runApplication(
    defineApplication({ modules: [fastifyHttp, trpcFastify, provideFlow([slow]), providePlugs([router])] }),
    { env, stopOn: [] },
  );
  const response = post(`${app.resolve(fastifyServer).url}/trpc/slow`, null);
  await entered.promise;
  const stopping = app.stop();
  finish.resolve();
  const answered = await response;
  assert.deepEqual([answered.status, await answered.json()], [200, { result: { data: "done" } }]);
  await stopping;
});
