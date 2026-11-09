import { fastifyHttpServer, fastifyPlugins } from "../src/index.ts";
import type { FastifyPlugin } from "../src/index.ts";
import { http, httpHandler, httpServer } from "@openknot-ts/knot-http-node";
import { config, defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import fastify from "fastify";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import type { RequestListener } from "node:http";
import { connect } from "node:http2";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

// Public, test-only TLS identity, trusted explicitly by the test clients.
const key = await readFile(new URL("./fixtures/localhost.key", import.meta.url));
const cert = await readFile(new URL("./fixtures/localhost.crt", import.meta.url));
const address = () => ({ port: 0, host: "127.0.0.1" });

function secureRequest(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = get(url, { ca: cert }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.once("error", reject);
      response.once("end", () => {
        assert.equal(response.statusCode, 200);
        resolve(body);
      });
    });
    client.once("error", reject);
  });
}

async function http2Request(url: string): Promise<string> {
  const client = connect(url, { ca: cert });
  try {
    const request = client.request({ ":path": "/native" });
    const response = once(request, "response");
    const ended = once(request, "end");
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.end();
    const [headers] = await response;
    assert.equal(headers[":status"], 200);
    await ended;
    return body;
  } finally {
    const closed = once(client, "close");
    client.close();
    await closed;
  }
}

test("HTTPS preserves native TLS options, instance methods and the listening origin", { timeout: 5_000 }, async () => {
  const server = fastifyHttpServer({
    create: () => {
      const instance = fastify({ https: { key, cert } });
      instance.get("/native", async (request) => request.raw.httpVersion);
      return instance;
    },
    listen: address,
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), { stopOn: [] });
  const value = app.resolve(server);
  try {
    value.native.server.setSecureContext({ key, cert });
    assert.match(value.url, /^https:\/\//);
    assert.equal(value.url, value.native.listeningOrigin);
    assert.equal(await secureRequest(`${value.url}/native`), "1.1");
  } finally {
    await app.stop();
  }
  assert.equal(value.listening, false);
});

test("HTTP2 preserves native server types and serves a real HTTP2 request", { timeout: 5_000 }, async () => {
  const server = fastifyHttpServer({
    create: () => {
      const instance = fastify({ http2: true });
      instance.get("/native", async (request) => request.raw.httpVersion);
      return instance;
    },
    listen: address,
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), { stopOn: [] });
  try {
    const value = app.resolve(server);
    value.native.server.updateSettings({ maxConcurrentStreams: 10 });
    assert.equal(await http2Request(value.url), "2.0");
  } finally {
    await app.stop();
  }
});

test("secure HTTP2 keeps allowHTTP1 and both native protocols work", { timeout: 5_000 }, async () => {
  const server = fastifyHttpServer({
    create: () => {
      const instance = fastify({ http2: true, https: { key, cert, allowHTTP1: true } });
      instance.get("/native", async (request) => request.raw.httpVersion);
      return instance;
    },
    listen: address,
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), { stopOn: [] });
  try {
    const value = app.resolve(server);
    value.native.server.setSecureContext({ key, cert });
    value.native.server.updateSettings({ maxConcurrentStreams: 10 });
    assert.equal(await http2Request(value.url), "2.0");
    assert.equal(await secureRequest(`${value.url}/native`), "1.1");
  } finally {
    await app.stop();
  }
});

test(
  "custom config allows Node and Fastify hosts together and callback plugins register natively",
  { timeout: 5_000 },
  async () => {
    const settings = config({
      FASTIFY_PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(0).max(65_535)),
      FASTIFY_HOST: z.string(),
    });
    const server = fastifyHttpServer({
      requirements: { settings },
      create: () => fastify(),
      listen: ({ settings }) => ({ port: settings.FASTIFY_PORT, host: settings.FASTIFY_HOST, backlog: 8 }),
    });
    const callback = unit({
      provides: fastifyPlugins,
      factory: (): FastifyPlugin => (instance, _options, done) => {
        instance.get("/callback", async () => "fastify");
        done();
      },
    });
    const handler = unit({
      provides: httpHandler,
      factory: (): RequestListener => (_request, response) => {
        response.end("node");
      },
    });
    const definition = defineApplication({ modules: [http, providePlugs([server, callback, handler])] });
    await assert.rejects(
      runApplication(definition, {
        env: { PORT: "0", FASTIFY_PORT: "70000", FASTIFY_HOST: "127.0.0.1" },
        stopOn: [],
      }),
      /FASTIFY_PORT/,
    );
    const app = await runApplication(definition, {
      env: { PORT: "0", FASTIFY_PORT: "0", FASTIFY_HOST: "127.0.0.1" },
      stopOn: [],
    });
    try {
      const nodeUrl = app.resolve(httpServer).url;
      const fastifyUrl = app.resolve(server).url;
      assert.notEqual(nodeUrl, fastifyUrl);
      assert.equal(await (await fetch(nodeUrl)).text(), "node");
      assert.equal(await (await fetch(`${fastifyUrl}/callback`)).text(), "fastify");
    } finally {
      await app.stop();
    }
  },
);

test("native listen options can bind a Unix socket instead of a TCP port", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openknot-fastify-socket-"));
  const socketPath = join(directory, "server.sock");
  const server = fastifyHttpServer({
    create: () => {
      const instance = fastify();
      instance.get("/socket", async () => "socket");
      return instance;
    },
    listen: () => ({ path: socketPath, readableAll: true, writableAll: true }),
  });
  try {
    const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), { stopOn: [] });
    try {
      assert.equal(app.resolve(server).url, socketPath);
      const response = await new Promise<string>((resolve, reject) => {
        const client = request({ socketPath, path: "/socket" }, (response) => {
          response.setEncoding("utf8");
          let body = "";
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.once("error", reject);
          response.once("end", () => resolve(body));
        });
        client.once("error", reject);
        client.end();
      });
      assert.equal(response, "socket");
    } finally {
      await app.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a caller's native listen signal still closes its server after startup", { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  const server = fastifyHttpServer({
    create: () => fastify(),
    listen: () => ({ ...address(), signal: controller.signal }),
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), { stopOn: [] });
  try {
    const value = app.resolve(server);
    const closed = once(value.native.server, "close");
    controller.abort();
    await closed;
    assert.equal(value.listening, false);
  } finally {
    await app.stop();
  }
});

test("explicit listen replaces default config even with additional constructor requirements", async () => {
  const settings = config({ API_PORT: z.coerce.number().int().min(0).max(65_535) });
  const server = fastifyHttpServer({
    requirements: { settings },
    create: ({ settings }) => {
      const instance = fastify();
      instance.get("/settings", async () => ({ configuredPort: settings.API_PORT }));
      return instance;
    },
    listen: ({ settings }) => ({ port: settings.API_PORT, host: "127.0.0.1" }),
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([server])] }), {
    env: { API_PORT: "0", PORT: "unused", HTTP_HOST: "" },
    stopOn: [],
  });
  try {
    const response = await fetch(`${app.resolve(server).url}/settings`);
    assert.deepEqual([response.status, await response.json()], [200, { configuredPort: 0 }]);
  } finally {
    await app.stop();
  }
});
