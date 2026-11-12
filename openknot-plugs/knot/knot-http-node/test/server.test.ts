import type { HttpMiddleware, HttpServer } from "../src/index.ts";
import { httpConfig, httpMiddleware, nodeHttpServer } from "../src/index.ts";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import {
  composeModule,
  defineApplication,
  hook,
  override,
  providePlugs,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { RequestListener } from "node:http";
import { Server, createServer } from "node:http";
import type { ListenOptions } from "node:net";
import { connect } from "node:net";
import { test } from "node:test";

// A free port, read like any other environment.
const env = { PORT: "0" };

test("the server runs the application's request listener through the container lifecycle", async () => {
  const handler = unit({
    factory: (): RequestListener => (request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end(`${request.method} ${request.url}`);
    },
  });
  const server = nodeHttpServer({ handler });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { server } })],
    }),
    { env },
  );
  const http = app.resolve(server);
  try {
    assert.equal(http.listening, true);
    assert.match(http.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${http.url}/roles?active=true`);
    assert.equal(await response.text(), "GET /roles?active=true");
  } finally {
    await app.stop();
  }
  assert.equal(http.listening, false);
  assert.throws(() => http.url, /The server is stopped/);
});

test("a handler or middleware that fails answers 500 without its private headers, and the host keeps serving", async (t) => {
  const reported = t.mock.method(console, "error", () => undefined);
  const reports: ErrorReport[] = [];
  const reporter = unit({ provides: errorReporter, factory: () => (report: ErrorReport) => reports.push(report) });
  const failure = new Error("private failure");
  const handler = unit({
    factory: (): RequestListener => (request, response) => {
      if (request.url === "/healthy") {
        response.end("ok");
        return;
      }
      response.setHeader("x-private", "must be cleared");
      if (request.url === "/throws") {
        throw failure;
      }
      return Promise.reject(failure);
    },
  });
  const server = nodeHttpServer({ handler });
  const failing = unit({
    provides: httpMiddleware,
    factory: (): HttpMiddleware => (request, _response, next) => {
      if (request.url === "/middleware") {
        throw failure;
      }
      return next();
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { server, failing, reporter } })] }),
    {
      env,
    },
  );
  try {
    const { url } = app.resolve(server);
    for (const path of ["/throws", "/rejects", "/middleware"]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("x-private"), null);
      assert.equal(await response.text(), "Internal Server Error");
    }
    assert.deepEqual(
      reported.mock.calls.map((call) => [String(call.arguments[0]).replace(/^\S+ /, ""), call.arguments[1]]),
      Array.from({ length: 3 }, () => ["ERROR openknot.http failed", { error: failure }]),
    );
    assert.deepEqual(
      reports.map((report) => [report.error, report.source, report.expected]),
      Array.from({ length: 3 }, () => [failure, "openknot.http", false]),
    );
    assert.equal(await (await fetch(`${url}/healthy`)).text(), "ok");
  } finally {
    await app.stop();
  }
});

test("a handler that fails after its headers closes the connection", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const handler = unit({
    factory: (): RequestListener => (_request, response) => {
      response.writeHead(200).write("partial");
      return Promise.reject(new Error("private failure"));
    },
  });
  const server = nodeHttpServer({ handler });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), { env });
  try {
    await assert.rejects(async () => {
      const response = await fetch(app.resolve(server).url);
      await response.text();
    });
  } finally {
    await app.stop();
  }
});

test("the host starts after what it uses and drains before that closes", async (t) => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let downstreamReady = false;
  let completed = false;
  let http: HttpServer;
  const downstream = resource({
    async initialize() {
      downstreamReady = true;
      return {
        value: undefined,
        release() {
          assert.equal(http.listening, false);
          assert.equal(completed, true);
          downstreamReady = false;
        },
      };
    },
  });
  const handler = unit({
    requirements: { downstream },
    factory: (): RequestListener => async (_request, response) => {
      assert.equal(downstreamReady, true);
      entered.resolve();
      await finish.promise;
      assert.equal(downstreamReady, true);
      completed = true;
      response.end("done");
    },
  });
  const server = nodeHttpServer({ handler });
  const app = await runApplication(
    defineApplication({
      // The host is deliberately listed before what it uses.
      modules: [composeModule({ providers: { server, downstream } })],
    }),
    { env },
  );
  http = app.resolve(server);
  const close = http.native.close;
  t.mock.method(http.native, "close", function (this: Server, callback?: (error?: Error) => void) {
    const result = close.call(this, callback);
    // The response finishes only after intake closes and the host marks it for draining.
    finish.resolve();
    return result;
  });
  const pending = fetch(http.url);
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

test("an invalid PORT stops startup before the server is built", async () => {
  let built = 0;
  const handler = unit({
    factory: (): RequestListener => {
      built++;
      return (_request, response) => response.end();
    },
  });
  const server = nodeHttpServer({ handler });
  const application = defineApplication({ modules: [composeModule({ providers: { server } })] });
  for (const PORT of ["http", "", " ", "-1", "1.5", "+1", "1e3", "0x10", "65536", "9007199254740992"]) {
    await assert.rejects(
      runApplication(application, { env: { PORT } }).then((app) => app.stop()),
      /PORT: must be an integer from 0 to 65535/,
    );
  }
  assert.equal(built, 0);
});

test("configuration preserves defaults, optional tuning and decimal integer boundaries", async () => {
  const application = defineApplication({ modules: [providePlugs([httpConfig])] });
  for (const { env, port, host, timeout } of [
    { env: {}, port: 3000, host: "127.0.0.1", timeout: undefined },
    {
      env: { PORT: "0000", HTTP_HOST: " localhost ", HTTP_REQUEST_TIMEOUT_MS: "0005" },
      port: 0,
      host: " localhost ",
      timeout: 5,
    },
    {
      env: { PORT: "65535", HTTP_REQUEST_TIMEOUT_MS: "9007199254740991" },
      port: 65535,
      host: "127.0.0.1",
      timeout: Number.MAX_SAFE_INTEGER,
    },
  ]) {
    const app = await runApplication(application, { env, stopOn: [] });
    try {
      const settings = app.resolve(httpConfig);
      assert.equal(settings.PORT, port);
      assert.equal(settings.HTTP_HOST, host);
      assert.equal(settings.HTTP_REQUEST_TIMEOUT_MS, timeout);
    } finally {
      await app.stop();
    }
  }
});

test("native options are preserved and explicit environment tuning takes precedence", async () => {
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.end("ok") });
  const server = nodeHttpServer({
    handler,
    options: {
      requestTimeout: 45_000,
      keepAliveTimeout: 12_000,
      highWaterMark: 8_192,
      maxHeaderSize: 32_768,
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
    env: {
      PORT: "0",
      HTTP_REQUEST_TIMEOUT_MS: "20000",
      HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS: "2000",
      HTTP_MAX_HEADER_SIZE: "256",
      HTTP_MAX_HEADERS_COUNT: "100",
      HTTP_MAX_REQUESTS_PER_SOCKET: "10",
      HTTP_SOCKET_TIMEOUT_MS: "0",
    },
  });
  const http = app.resolve(server);
  try {
    assert.equal(http.native.requestTimeout, 20_000);
    assert.equal(
      http.native.headersTimeout,
      20_000,
      "Node derives its default header timeout from the request timeout.",
    );
    assert.equal(http.native.keepAliveTimeout, 12_000);
    assert.equal(http.native.keepAliveTimeoutBuffer, 2_000);
    assert.equal(http.native.maxHeadersCount, 100);
    assert.equal(http.native.maxRequestsPerSocket, 10);
    assert.equal(http.native.timeout, 0, "Streaming responses have no socket deadline by default.");
    http.native.on("request", (request) => assert.equal(request.readableHighWaterMark, 8_192));
    assert.equal((await fetch(http.url)).status, 200);
    assert.equal((await fetch(http.url, { headers: { "x-large": "x".repeat(1_024) } })).status, 431);
  } finally {
    await app.stop();
  }
});

test("invalid environment values are reported together before constructing a handler", async () => {
  let built = false;
  const handler = unit({
    factory: (): RequestListener => {
      built = true;
      return (_request, response) => response.end();
    },
  });
  const server = nodeHttpServer({ handler });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
      env: {
        PORT: "",
        HTTP_HOST: " ",
        HTTP_HEADERS_TIMEOUT_MS: "-1",
        HTTP_KEEP_ALIVE_TIMEOUT_MS: "Infinity",
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const name of ["PORT", "HTTP_HOST", "HTTP_HEADERS_TIMEOUT_MS", "HTTP_KEEP_ALIVE_TIMEOUT_MS"]) {
        assert.match(error.message, new RegExp(`${name}:`));
      }
      return true;
    },
  );
  assert.equal(built, false);
});

test("a host reached only as a dependency listens like any other resource", async () => {
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.end("ok") });
  const server = nodeHttpServer({ handler });
  const consumer = unit({ requirements: { server }, factory: ({ server }) => server });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { consumer } })] }), {
    env,
  });
  try {
    assert.equal(app.resolve(consumer), app.resolve(server));
    assert.equal(app.resolve(server).listening, true);
    assert.equal(await (await fetch(app.resolve(server).url)).text(), "ok");
  } finally {
    await app.stop();
  }
});

test("listen failure rejects application startup and releases the port for a later application", async () => {
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.end("ok") });
  const server = nodeHttpServer({ handler });
  const definition = defineApplication({ modules: [composeModule({ providers: { server } })] });
  const first = await runApplication(definition, { env });
  const occupied = first.resolve(server);
  const port = new URL(occupied.url).port;
  try {
    await assert.rejects(runApplication(definition, { env: { PORT: port } }), { code: "EADDRINUSE" });
  } finally {
    await first.stop();
  }
  const retry = await runApplication(definition, { env: { PORT: port } });
  try {
    assert.equal(await (await fetch(retry.resolve(server).url)).text(), "ok");
  } finally {
    await retry.stop();
  }
});

test("cancelling listen releases the native socket before startup rejects", async (t) => {
  const shutdown = new AbortController();
  const reason = new Error("cancelled listen");
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.end() });
  const server = nodeHttpServer({ handler });
  let listeningListeners = 0;
  const listen = Server.prototype.listen;
  const listening = t.mock.method(Server.prototype, "listen", function (this: Server, options: ListenOptions) {
    listeningListeners = this.listenerCount("listening");
    const result = listen.call(this, options);
    shutdown.abort(reason);
    return result;
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
      env,
      signal: shutdown.signal,
    }),
    (error) => error === reason,
  );
  const native = listening.mock.calls[0]?.this as Server | undefined;
  assert.ok(native);
  assert.equal(native.listening, false);
  assert.equal(native.listenerCount("listening"), listeningListeners);
  assert.equal(native.listenerCount("error"), 0);
});

test("an overridden host exposes its value without running a native lifecycle", async () => {
  const handler = unit({
    factory: (): RequestListener => {
      throw new Error("The overridden host must not construct its handler.");
    },
  });
  const server = nodeHttpServer({ handler });
  const stub: HttpServer = { url: "http://stub", listening: false, native: createServer() };
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
    env,
    overrides: [override(server, stub)],
  });
  assert.equal(app.resolve(server), stub);
  await app.stop();
});

test(
  "shutdown waits for an admitted stream and rejects later pipelined requests before their handler",
  {
    timeout: 5_000,
  },
  async () => {
    const entered = Promise.withResolvers<void>();
    const later = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const handled: string[] = [];
    const handler = unit({
      factory: (): RequestListener => async (request, response) => {
        handled.push(request.url ?? "");
        response.write("begin");
        entered.resolve();
        await finish.promise;
        response.end("end");
      },
    });
    const server = nodeHttpServer({ handler });
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
      env,
    });
    const http = app.resolve(server);
    http.native.on("request", (request) => {
      if (request.url === "/later") {
        later.resolve();
      }
    });
    const socket = connect(Number(new URL(http.url).port), "127.0.0.1");
    const closed = once(socket, "close");
    let received = "";
    socket.setEncoding("utf8").on("data", (chunk) => {
      received += chunk;
    });
    try {
      await once(socket, "connect");
      socket.write("GET /admitted HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await entered.promise;
      let finished = false;
      const stopping = app.stop().then(() => {
        finished = true;
      });
      socket.write("GET /later HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await later.promise;
      assert.equal(finished, false);
      assert.deepEqual(handled, ["/admitted"]);
      finish.resolve();
      await stopping;
      await closed;
      assert.match(received, /begin/);
      assert.match(received, /end/);
    } finally {
      finish.resolve();
      socket.destroy();
      await app.stop();
    }
  },
);

test("the host unwinds a listening server when a later startup task fails", async () => {
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.end() });
  const server = nodeHttpServer({ handler });
  let native: Server | undefined;
  const failed = hook({
    requirements: { server },
    run({ server }) {
      native = server.native;
      assert.equal(native.listening, true);
      throw new Error("Later startup task failed");
    },
  });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { server } })],
        startupTasks: [failed],
      }),
      { env },
    ),
    /Later startup task failed/,
  );
  assert.ok(native);
  assert.equal(native.listening, false);
});

test("stopping closes connections without an admitted request at once and leaves no native handle behind", async () => {
  // Closed handles leave libuv in the close phase that follows the current turn of the event loop.
  const resources = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return process.getActiveResourcesInfo().sort();
  };
  const before = await resources();
  const handler = unit({ factory: (): RequestListener => (_request, response) => response.end("ok") });
  const server = nodeHttpServer({ handler });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
    env,
    stopOn: [],
  });
  const port = Number(new URL(app.resolve(server).url).port);
  const kept = connect(port, "127.0.0.1");
  await once(kept, "connect");
  kept.write("GET / HTTP/1.1\r\nHost: test\r\nConnection: keep-alive\r\n\r\n");
  await once(kept, "data");
  const idle = connect(port, "127.0.0.1");
  await once(idle, "connect");
  // Its headers never complete, so no request reaches the application.
  const partial = connect(port, "127.0.0.1");
  await once(partial, "connect");
  partial.write("GET / HTTP/1.1\r\nHost: test\r\n");
  const clients = [kept, idle, partial];
  // The server closes these connections, so a client may see its socket reset.
  for (const client of clients) {
    client.on("error", (error: NodeJS.ErrnoException) => assert.equal(error.code, "ECONNRESET"));
  }
  const closed = Promise.all(clients.map((client) => new Promise((resolve) => client.once("close", resolve))));
  await app.stop();
  await closed;
  assert.deepEqual(await resources(), before);
});
