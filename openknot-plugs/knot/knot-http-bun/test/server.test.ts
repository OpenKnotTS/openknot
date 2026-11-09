import type { HttpHandler, HttpServer } from "../src/index.ts";
import { bunHttpServer, http, httpConfig, httpHandler, httpServer } from "../src/index.ts";
import { defineApplication, hook, override, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import type { Server } from "bun";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { connect } from "node:net";

const options = { env: { PORT: "0" }, stopOn: [] } as const;

test("the default host validates its handler before acquiring resources", async () => {
  let acquired = 0;
  const database = resource({ initialize: async () => ({ value: ++acquired, release() {} }) });
  const definition = defineApplication({ modules: [http, providePlugs([database])] });
  // @ts-expect-error The default host requires a native Bun handler implementation.
  await assert.rejects(runApplication(definition, options), /handler.*has no implementation/);
  assert.equal(acquired, 0);
});

test("a native handler binds through provides and the ready module owns its lifecycle", async () => {
  let native: Server<undefined>;
  const handler = unit({
    provides: httpHandler,
    factory: (): HttpHandler =>
      function (request, server) {
        assert.equal(this, native);
        assert.equal(server, native);
        return new Response(`${request.method} ${new URL(request.url).pathname}`);
      },
  });
  const app = await runApplication(defineApplication({ modules: [http, providePlugs([handler])] }), options);
  const server = app.resolve(httpServer);
  native = server.native;
  try {
    assert.equal(server.listening, true);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(await (await fetch(new URL("/roles", server.url))).text(), "GET /roles");
  } finally {
    const stopping = app.stop();
    assert.equal(stopping, app.stop());
    await stopping;
  }
  assert.equal(server.listening, false);
  assert.throws(() => server.url, /stopped/);
});

test("hosts start after what they use and drain admitted requests before its cleanup", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const order: string[] = [];
  let downstreamReady = false;
  const database = resource({
    initialize: async () => ({
      value: {},
      release() {
        order.push("database.release");
      },
    }),
  });
  const downstream = resource({
    requirements: { database },
    initialize: async () => {
      downstreamReady = true;
      order.push("downstream");
      return {
        value: undefined,
        release() {
          downstreamReady = false;
          order.push("downstream.release");
        },
      };
    },
  });
  const handler = unit({
    requirements: { downstream },
    factory: (): HttpHandler => async (request) => {
      assert.equal(downstreamReady, true);
      entered.resolve();
      await finish.promise;
      assert.equal(request.signal.aborted, false);
      assert.equal(downstreamReady, true);
      order.push("response");
      return new Response("drained");
    },
  });
  const host = bunHttpServer({ handler });
  const startup = hook({
    requirements: { host },
    run: async ({ host }) => {
      assert.equal(host.listening, true);
      assert.equal(downstreamReady, true);
      order.push("startup");
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [providePlugs([host])],
      startupTasks: [startup],
    }),
    options,
  );
  const response = fetch(app.resolve(host).url);
  try {
    await entered.promise;
    const stopping = app.stop();
    assert.equal(downstreamReady, true);
    finish.resolve();
    assert.equal(await (await response).text(), "drained");
    await stopping;
    assert.deepEqual(order, ["downstream", "startup", "response", "downstream.release", "database.release"]);
  } finally {
    finish.resolve();
    await response;
    await app.stop();
  }
});

test("a dependency-only host listens, and an overridden host constructs no native server", async () => {
  const handler = unit({ factory: (): HttpHandler => () => new Response("unused") });
  const host = bunHttpServer({ handler });
  const consumer = unit({ requirements: { host }, factory: ({ host }) => host });
  const dependencyOnly = await runApplication(defineApplication({ modules: [providePlugs([consumer])] }), options);
  try {
    assert.equal(dependencyOnly.resolve(consumer), dependencyOnly.resolve(host));
    assert.equal(dependencyOnly.resolve(host).listening, true);
  } finally {
    await dependencyOnly.stop();
  }
  const stub: HttpServer = { native: {} as Server<undefined>, url: "http://stub/", listening: false };
  const replaced = await runApplication(defineApplication({ modules: [providePlugs([host])] }), {
    ...options,
    overrides: [override(host, stub)],
  });
  try {
    assert.equal(replaced.resolve(host), stub);
  } finally {
    await replaced.stop();
  }
});

test("invalid environment values fail together before acquisition", async () => {
  let acquired = false;
  const database = resource({
    initialize: async () => {
      acquired = true;
      return { value: {}, release() {} };
    },
  });
  const handler = unit({ provides: httpHandler, factory: (): HttpHandler => () => new Response("unused") });
  const application = defineApplication({ modules: [http, providePlugs([handler, database])] });
  const invalid = ["", " ", "-1", "1.5", "+1", "1e3", "0x10", "9007199254740992"];
  for (const env of [
    { PORT: "-1", HTTP_HOST: " ", HTTP_IDLE_TIMEOUT_SECONDS: "256", HTTP_MAX_REQUEST_BODY_SIZE: "NaN" },
    { PORT: "65536" },
    ...["PORT", "HTTP_IDLE_TIMEOUT_SECONDS", "HTTP_MAX_REQUEST_BODY_SIZE"].flatMap((name) =>
      invalid.map((value) => ({ [name]: value })),
    ),
  ]) {
    await assert.rejects(
      runApplication(application, { env, stopOn: [] }).then((app) => app.stop()),
      (error: Error) => {
        for (const name of Object.keys(env)) {
          assert.match(error.message, new RegExp(name));
        }
        return true;
      },
    );
  }
  assert.equal(acquired, false);
});

test("unset configuration preserves native options and explicit numeric boundaries", async () => {
  const application = defineApplication({ modules: [providePlugs([httpConfig])] });
  for (const { env, port, host, idle, body } of [
    { env: {}, port: undefined, host: undefined, idle: undefined, body: undefined },
    {
      env: {
        PORT: "0000",
        HTTP_HOST: " localhost ",
        HTTP_IDLE_TIMEOUT_SECONDS: "000",
        HTTP_MAX_REQUEST_BODY_SIZE: "0005",
      },
      port: 0,
      host: " localhost ",
      idle: 0,
      body: 5,
    },
    {
      env: { PORT: "65535", HTTP_IDLE_TIMEOUT_SECONDS: "255", HTTP_MAX_REQUEST_BODY_SIZE: "9007199254740991" },
      port: 65535,
      host: undefined,
      idle: 255,
      body: Number.MAX_SAFE_INTEGER,
    },
  ]) {
    const app = await runApplication(application, { env, stopOn: [] });
    try {
      const settings = app.resolve(httpConfig);
      assert.equal(settings.PORT, port);
      assert.equal(settings.HTTP_HOST, host);
      assert.equal(settings.HTTP_IDLE_TIMEOUT_SECONDS, idle);
      assert.equal(settings.HTTP_MAX_REQUEST_BODY_SIZE, body);
    } finally {
      await app.stop();
    }
  }
});

test("bind failure unwinds resources and the same declaration can start after the port is released", async () => {
  const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
  let released = 0;
  const dependency = resource({
    initialize: async () => ({
      value: {},
      release() {
        released++;
      },
    }),
  });
  const handler = unit({ requirements: { dependency }, factory: (): HttpHandler => () => new Response("available") });
  const host = bunHttpServer({ handler });
  const definition = defineApplication({ modules: [providePlugs([host])] });
  const settings = { env: { PORT: String(occupied.port) }, stopOn: [] };
  try {
    await assert.rejects(runApplication(definition, settings), /EADDRINUSE|in use/);
  } finally {
    await occupied.stop();
  }
  assert.equal(released, 1);
  const app = await runApplication(definition, settings);
  try {
    assert.equal(await (await fetch(app.resolve(host).url)).text(), "available");
  } finally {
    await app.stop();
  }
  assert.equal(released, 2);
});

test("startup task failure and startup cancellation release an already listening host", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("startup interrupted");
    let port = "";
    const handler = unit({ factory: (): HttpHandler => () => new Response("ok") });
    const host = bunHttpServer({ handler });
    const startup = hook({
      requirements: { host },
      run: async ({ host }, { signal }) => {
        port = String(host.native.port);
        entered.resolve();
        if (cancel) {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        throw failure;
      },
    });
    const pending = runApplication(defineApplication({ modules: [providePlugs([host])], startupTasks: [startup] }), {
      ...options,
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, (error) => error === failure);
    await entered.promise;
    if (cancel) {
      controller.abort(failure);
    }
    await rejected;
    const next = await runApplication(defineApplication({ modules: [providePlugs([host])] }), {
      env: { PORT: port },
      stopOn: [],
    });
    await next.stop();
  }
});

test("native options, routes and error responses are preserved, with explicit env taking precedence", async () => {
  const failure = new Error("native failure");
  const handler = unit({
    factory: (): HttpHandler => async (request) => {
      if (new URL(request.url).pathname === "/error") {
        throw failure;
      }
      return new Response(await request.text());
    },
  });
  const host = bunHttpServer({
    handler,
    options: {
      port: 1,
      hostname: "0.0.0.0",
      idleTimeout: 1,
      maxRequestBodySize: 4,
      routes: { "/native": new Response("native route") },
      error(error) {
        assert.equal(error, failure);
        return new Response("mapped", { status: 502 });
      },
    },
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([host])] }), {
    env: { PORT: "0", HTTP_HOST: "127.0.0.1", HTTP_IDLE_TIMEOUT_SECONDS: "0", HTTP_MAX_REQUEST_BODY_SIZE: "10" },
    stopOn: [],
  });
  const server = app.resolve(host);
  try {
    assert.equal(server.native.hostname, "127.0.0.1");
    assert.notEqual(server.native.port, 1);
    assert.equal(server.native.development, false);
    assert.equal(await (await fetch(new URL("/native", server.url))).text(), "native route");
    assert.equal(await (await fetch(server.url, { method: "POST", body: "12345" })).text(), "12345");
    assert.equal((await fetch(server.url, { method: "POST", body: "12345678901" })).status, 413);
    const failed = await fetch(new URL("/error", server.url));
    assert.equal(failed.status, 502);
    assert.equal(await failed.text(), "mapped");
  } finally {
    await app.stop();
  }
});

test("client cancellation reaches the original Request signal", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const handler = unit({
    factory: (): HttpHandler => async (request) => {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await aborted.promise;
      return new Response("cancelled");
    },
  });
  const host = bunHttpServer({ handler });
  const app = await runApplication(defineApplication({ modules: [providePlugs([host])] }), options);
  const controller = new AbortController();
  const response = fetch(app.resolve(host).url, { signal: controller.signal });
  const rejected = assert.rejects(response, /abort/i);
  try {
    await entered.promise;
    controller.abort();
    await rejected;
    await aborted.promise;
  } finally {
    controller.abort();
    await app.stop();
  }
});

test("shutdown drains streaming bodies without aborting an admitted request", async () => {
  let body: ReadableStreamDefaultController<Uint8Array>;
  let requestSignal: AbortSignal;
  const handler = unit({
    factory: (): HttpHandler => (request) => {
      requestSignal = request.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }),
      );
    },
  });
  const host = bunHttpServer({ handler, options: { idleTimeout: 0 } });
  const app = await runApplication(defineApplication({ modules: [providePlugs([host])] }), options);
  const response = await fetch(app.resolve(host).url);
  const reader = response.body!.getReader();
  try {
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
    const stopping = app.stop();
    assert.equal(requestSignal!.aborted, false);
    body!.enqueue(new TextEncoder().encode("last"));
    body!.close();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
    assert.equal((await reader.read()).done, true);
    await stopping;
  } finally {
    await reader.cancel();
    await app.stop();
  }
});

test("stopping closes connections without an admitted request and leaves no native work pending", async () => {
  const handler = unit({ provides: httpHandler, factory: (): HttpHandler => () => new Response("ok") });
  const app = await runApplication(defineApplication({ modules: [http, providePlugs([handler])] }), options);
  const server = app.resolve(httpServer);
  const native = server.native;
  const open = async () => {
    const client = connect(native.port!, "127.0.0.1");
    // The server closes these connections, so a client may see its socket reset.
    client.on("error", (error: NodeJS.ErrnoException) => assert.equal(error.code, "ECONNRESET"));
    await new Promise((resolve) => client.once("connect", resolve));
    return client;
  };
  const kept = await open();
  kept.write("GET / HTTP/1.1\r\nHost: test\r\nConnection: keep-alive\r\n\r\n");
  await new Promise((resolve) => kept.once("data", resolve));
  // Its headers never complete, so no request reaches the application. A connection that never sends a byte is not
  // yet an HTTP connection to Bun, which leaves it to its native idle timeout without holding the process.
  const partial = await open();
  partial.write("GET / HTTP/1.1\r\nHost: test\r\n");
  const clients = [kept, partial];
  const closed = Promise.all(clients.map((client) => new Promise((resolve) => client.once("close", resolve))));
  await app.stop();
  await closed;
  assert.equal(native.pendingRequests, 0);
  assert.equal(native.pendingWebSockets, 0);
  assert.equal(server.listening, false);
});
