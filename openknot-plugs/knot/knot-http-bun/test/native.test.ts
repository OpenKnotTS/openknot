import type { HttpHandler, HttpMiddleware } from "../src/index.ts";
import { bunHttpServer, http, httpHandler, httpMiddleware, httpServer } from "../src/index.ts";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import type { Server } from "bun";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const options = { env: { PORT: "0" }, stopOn: [] } as const;

test("listed middleware preserves native requests, server context, order and short-circuit responses", async () => {
  let native: Server<undefined>;
  let original: Request;
  const order: string[] = [];
  const unlisted = unit({
    provides: httpMiddleware,
    factory: (): HttpMiddleware => () => {
      throw new Error("A dependency-only contribution must not run");
    },
  });
  const first = unit({
    provides: httpMiddleware,
    requirements: { unlisted },
    factory: (): HttpMiddleware =>
      async function (request, server, next) {
        assert.equal(this, native);
        assert.equal(server, native);
        original = request;
        order.push("first");
        const response = await next();
        assert.ok(response instanceof Response);
        response.headers.set("x-middleware", "first");
        return response;
      },
  });
  const second = unit({
    provides: httpMiddleware,
    factory: (): HttpMiddleware => (request, _server, next) => {
      order.push("second");
      if (new URL(request.url).pathname === "/intercept") {
        return new Response("intercepted");
      }
      return next();
    },
  });
  const handler = unit({
    provides: httpHandler,
    factory: (): HttpHandler => (request) => {
      assert.equal(request, original);
      order.push("handler");
      return new Response(request.body);
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [http, providePlugs([first, second, handler])] }),
    options,
  );
  native = app.resolve(httpServer).native;
  try {
    const result = await fetch(app.resolve(httpServer).url, { method: "POST", body: "original stream" });
    assert.equal(await result.text(), "original stream");
    assert.equal(result.headers.get("x-middleware"), "first");
    assert.deepEqual(order, ["first", "second", "handler"]);
    order.length = 0;
    assert.equal(await (await fetch(new URL("/intercept", app.resolve(httpServer).url))).text(), "intercepted");
    assert.deepEqual(order, ["first", "second"]);
  } finally {
    await app.stop();
  }
});

test("native WebSocket upgrades retain typed data and iterator-independent native cleanup", async () => {
  type Data = { readonly name: string };
  const closed = Promise.withResolvers<void>();
  const handler = unit({
    factory: (): HttpHandler<Data> => (request, server) => {
      if (server.upgrade(request, { data: { name: "alice" } })) {
        return;
      }
      return new Response("Expected upgrade", { status: 400 });
    },
  });
  const host = bunHttpServer({
    handler,
    options: {
      websocket: {
        message(socket, message) {
          socket.send(`${socket.data.name}:${message}`);
        },
        close() {
          closed.resolve();
        },
      },
    },
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([host])] }), options);
  const socket = new WebSocket(app.resolve(host).url.replace("http:", "ws:"));
  try {
    const message = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("hello");
      socket.onmessage = (event) => resolve(String(event.data));
      socket.onerror = () => reject(new Error("WebSocket failed"));
    });
    assert.equal(message, "alice:hello");
    assert.equal(app.resolve(host).native.pendingWebSockets, 1);
  } finally {
    socket.close();
    await closed.promise;
    await app.stop();
  }
});

test("native Unix socket options are retained and conflict with explicit TCP environment settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openknot-bun-"));
  const path = join(directory, "http.sock");
  const handler = unit({ factory: (): HttpHandler => () => new Response("unix") });
  const host = bunHttpServer({ handler, options: { unix: path } });
  const definition = defineApplication({ modules: [providePlugs([host])] });
  try {
    await assert.rejects(runApplication(definition, options), /Unix.*PORT/);
    const app = await runApplication(definition, { env: {}, stopOn: [] });
    try {
      assert.equal(await (await fetch("http://localhost/", { unix: path })).text(), "unix");
    } finally {
      await app.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stopping closes open WebSockets as going away instead of waiting for their clients", async () => {
  const closed: number[] = [];
  const handler = unit({
    factory: (): HttpHandler => (request, server) =>
      server.upgrade(request) ? undefined : new Response("Expected upgrade", { status: 400 }),
  });
  const host = bunHttpServer({
    handler,
    options: {
      websocket: {
        message() {},
        close(_socket, code) {
          closed.push(code);
        },
      },
    },
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([host])] }), options);
  const socket = new WebSocket(app.resolve(host).url.replace("http:", "ws:"));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("WebSocket failed"));
  });
  // A client that keeps its socket open, as a browser tab does.
  const ended = new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)));
  await app.stop();
  assert.equal(await ended, 1001);
  assert.deepEqual(closed, [1001]);
});
