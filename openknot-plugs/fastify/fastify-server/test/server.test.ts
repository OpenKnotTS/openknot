import type { FastifyPlugin, FastifyServer } from "../src/index.ts";
import { fastifyHttp, fastifyHttpServer, fastifyPlugins, fastifyServer } from "../src/index.ts";
import type { Definition } from "@openknot-ts/wire";
import {
  composeModule,
  config,
  defineApplication,
  providePlugs,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import fastify from "fastify";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

const env = { PORT: "0" };

function route(path: string, requirements: Record<string, Definition> = {}, answer = path) {
  return unit({
    provides: fastifyPlugins,
    requirements,
    factory: (): FastifyPlugin => async (instance) => {
      instance.get(path, async () => answer);
    },
  });
}

test("the selected plugins join the host in module order and it stops listening on stop", async () => {
  const order: string[] = [];
  const plugin = (name: string) =>
    unit({
      provides: fastifyPlugins,
      factory: (): FastifyPlugin => async (instance) => {
        order.push(name);
        instance.get(`/${name}`, async () => name);
      },
    });
  const app = await runApplication(
    defineApplication({ modules: [fastifyHttp, providePlugs([plugin("first")]), providePlugs([plugin("second")])] }),
    { env, stopOn: [] },
  );
  const server = app.resolve(fastifyServer);
  try {
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(server.listening, true);
    for (const name of ["first", "second"]) {
      assert.equal(await (await fetch(`${server.url}/${name}`)).text(), name);
    }
    assert.equal((await fetch(`${server.url}/missing`)).status, 404);
  } finally {
    await app.stop();
  }
  assert.equal(server.listening, false);
});

test("the host starts after what its plugins use and drains admitted requests before that closes", async (t) => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let downstreamReady = false;
  let completed = false;
  let server: FastifyServer;
  const downstream = resource({
    async initialize() {
      downstreamReady = true;
      return {
        value: undefined,
        release() {
          assert.equal(server.listening, false);
          assert.equal(completed, true);
          downstreamReady = false;
        },
      };
    },
  });
  const slow = unit({
    provides: fastifyPlugins,
    requirements: { downstream },
    factory: (): FastifyPlugin => async (instance) => {
      instance.get("/slow", async () => {
        assert.equal(downstreamReady, true);
        entered.resolve();
        await finish.promise;
        completed = true;
        return "done";
      });
    },
  });
  // The host is deliberately listed before what its plugin uses.
  const app = await runApplication(
    defineApplication({ modules: [fastifyHttp, composeModule({ providers: { slow, downstream } })] }),
    {
      env,
      stopOn: [],
    },
  );
  server = app.resolve(fastifyServer);
  const close = server.native.close.bind(server.native);
  t.mock.method(server.native, "close", () => {
    const closing = close();
    // The response finishes only after intake closes and the host marks it for draining.
    finish.resolve();
    return closing;
  });
  const pending = fetch(`${server.url}/slow`);
  try {
    await entered.promise;
    await app.stop();
    const response = await pending;
    assert.equal(response.headers.get("connection"), "close");
    assert.equal(await response.text(), "done");
    assert.equal(downstreamReady, false);
  } finally {
    finish.resolve();
    await app.stop();
  }
});

test("a startup cancelled while a plugin loads closes the instance without listening", async () => {
  const controller = new AbortController();
  let instanceListening: boolean | undefined;
  const loading = unit({
    provides: fastifyPlugins,
    factory: (): FastifyPlugin => async (instance) => {
      instance.addHook("onClose", async () => {
        instanceListening = instance.server.listening;
      });
      controller.abort(new Error("stopped during startup"));
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [fastifyHttp, providePlugs([loading, route("/after")])] }), {
      env,
      stopOn: [],
      signal: controller.signal,
    }),
    /stopped during startup/,
  );
  assert.equal(instanceListening, false);
});

test("a plugin that fails to load rejects startup with its error and closes the instance", async () => {
  let closed = false;
  const failing = unit({
    provides: fastifyPlugins,
    factory: (): FastifyPlugin => async (instance) => {
      instance.addHook("onClose", async () => {
        closed = true;
      });
      throw new Error("plugin failed");
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [fastifyHttp, providePlugs([failing])] }), { env, stopOn: [] }),
    /plugin failed/,
  );
  assert.equal(closed, true);
});

test("an invalid PORT stops startup before the instance is built", async () => {
  let built = 0;
  const counted = unit({
    provides: fastifyPlugins,
    factory: (): FastifyPlugin => {
      built++;
      return async () => undefined;
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [fastifyHttp, providePlugs([counted])] }), {
      env: { PORT: "70000" },
      stopOn: [],
    }),
    /PORT/,
  );
  assert.equal(built, 0);
});

test("omitting listen on a custom Fastify factory selects the validated default config", async () => {
  const settings = config({ REQUEST_ID_HEADER: z.string().default("x-custom-id") });
  let built = 0;
  const server = fastifyHttpServer({
    requirements: { settings },
    create: ({ settings }) => {
      built++;
      const instance = fastify({ requestIdHeader: settings.REQUEST_ID_HEADER });
      instance.get("/default", async (request) => ({ id: request.id }));
      return instance;
    },
  });
  const application = defineApplication({ modules: [providePlugs([server])] });
  await assert.rejects(
    runApplication(application, { env: { PORT: "invalid" }, stopOn: [] }).then((app) => app.stop()),
    /PORT/,
  );
  assert.equal(built, 0);
  const app = await runApplication(application, { env, stopOn: [] });
  try {
    const value = app.resolve(server);
    assert.match(value.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${value.url}/default`, { headers: { "x-custom-id": "native-id" } });
    assert.deepEqual([response.status, await response.json()], [200, { id: "native-id" }]);
  } finally {
    await app.stop();
  }
});
